import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as Chart from '@/lib/chart'
import * as DH from '@/lib/display-helpers'
import * as RSel from '@/lib/reselect'
import { assertNever } from '@/lib/type-guards'
import * as I18n from '@/messages/i18n'
import * as L_Msgs from '@/messages/layer.messages'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import * as BM from '@/models/battlemetrics.models'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer.models'
import * as MH from '@/models/match-history.models'
import * as Activity from '@/models/player-activity.models'
import * as PG from '@/models/player-groupings.models'
import * as Pop from '@/models/population.models'
import * as SM from '@/models/squad.models'
import * as TA from '@/models/team-attribution.models'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import type { ClientOnlySettingsStore } from '@/systems/client-only-settings.client'
import type { PublicSettings } from '@/systems/settings.server'

export type TeamDisplay = { label: string; color: string }

export type BreakdownMember = { id: SM.PlayerId; name: string }

/**
 * When each team's kills and deaths landed over a match, in ms since the epoch, in the order they happened. Index 0
 * is team 1. Counted by the same rule as the stored scoreline (MH.combatCredit), so the chart and Match History agree.
 */
export type ScorelineTimeline = {
	kills: readonly [readonly number[], readonly number[]]
	deaths: readonly [readonly number[], readonly number[]]
	wounds: readonly [number, number]
}

type MutableTimeline = { kills: [number[], number[]]; deaths: [number[], number[]]; wounds: [number, number] }

const EMPTY_TIMELINE: ScorelineTimeline = { kills: [[], []], deaths: [[], []], wounds: [0, 0] }

function copyTimeline(timeline: ScorelineTimeline): MutableTimeline {
	return {
		kills: [[...timeline.kills[0]], [...timeline.kills[1]]],
		deaths: [[...timeline.deaths[0]], [...timeline.deaths[1]]],
		wounds: [timeline.wounds[0], timeline.wounds[1]],
	}
}

function addCombat(timeline: MutableTimeline, event: CHAT.EventEnriched, credit: { deathTo: number; creditTo: number }) {
	if (credit.deathTo !== -1) timeline.deaths[credit.deathTo].push(event.time)
	if (credit.creditTo === -1) return
	if (event.type === 'PLAYER_DIED') timeline.kills[credit.creditTo].push(event.time)
	else timeline.wounds[credit.creditTo]++
}

const historicalTimelines = new WeakMap<readonly CHAT.EventEnriched[], ScorelineTimeline>()

// A replayed match's timeline, built once per fetched event list.
function historicalTimeline(events: readonly CHAT.EventEnriched[]): ScorelineTimeline {
	let timeline = historicalTimelines.get(events)
	if (!timeline) {
		const built = copyTimeline(EMPTY_TIMELINE)
		for (const event of events) {
			const credit = MH.combatCredit(event)
			if (credit) addCombat(built, event, credit)
		}
		timeline = built
		historicalTimelines.set(events, timeline)
	}
	return timeline
}

/**
 * The live match's timeline, scanning only the buffer entries appended since the previous call, like
 * CHAT.createBufferFilter. The result keeps its identity until a combat event arrives, and is copied rather than
 * appended to when one does, so a chart holding the previous one never sees it change.
 */
function createTimelineTracker() {
	let buffer: CHAT.EventEnriched[] | null = null
	let epoch = -1
	let scanned = 0
	let trackedMatchId = -1
	let result = EMPTY_TIMELINE
	return (state: CHAT.ChatState, matchId: number): ScorelineTimeline => {
		if (state.eventBuffer !== buffer || state.bufferEpoch !== epoch || state.eventBuffer.length < scanned || matchId !== trackedMatchId) {
			buffer = state.eventBuffer
			epoch = state.bufferEpoch
			trackedMatchId = matchId
			scanned = 0
			result = EMPTY_TIMELINE
		}
		const entries = state.eventBuffer
		let next: MutableTimeline | null = null
		for (; scanned < entries.length; scanned++) {
			const event = entries[scanned]
			if (event.matchId !== matchId) continue
			const credit = MH.combatCredit(event)
			if (!credit) continue
			next ??= copyTimeline(result)
			addCombat(next, event, credit)
		}
		if (next) result = next
		return result
	}
}

// one tracker per buffer: a reset swaps the buffer, which retires its tracker with it
const liveTrackers = new WeakMap<CHAT.EventEnriched[], ReturnType<typeof createTimelineTracker>>()

function liveTimeline(state: CHAT.ChatState, matchId: number): ScorelineTimeline {
	let track = liveTrackers.get(state.eventBuffer)
	if (!track) {
		track = createTimelineTracker()
		liveTrackers.set(state.eventBuffer, track)
	}
	return track(state, matchId)
}

// A count over time, starting from zero at x = 0. x is ms since `start`.
function cumulative(times: readonly number[], start: number): Chart.Point[] {
	const points: Chart.Point[] = [{ x: 0, y: 0 }]
	for (let i = 0; i < times.length; i++) points.push({ x: Math.max(0, times[i] - start), y: i + 1 })
	return points
}

// team 1's kills minus team 2's, over time
function killLead(kills: ScorelineTimeline['kills'], start: number): Chart.Point[] {
	const [a, b] = kills
	const points: Chart.Point[] = [{ x: 0, y: 0 }]
	let i = 0
	let j = 0
	while (i < a.length || j < b.length) {
		const takeA = j >= b.length || (i < a.length && a[i] <= b[j])
		const time = takeA ? a[i++] : b[j++]
		points.push({ x: Math.max(0, time - start), y: i - j })
	}
	return points
}

// A match as the population chart marks it. `end` is where the next match starts, or the chart's end.
export type PopulationBand = {
	ordinal: number
	label: string
	start: number
	roundEnd: number | null
	end: number
	// the match the panel and Server Activity show, which the chart outlines
	displayed: boolean
}

/**
 * The population chart's data: one point per bucket, `bucketMs` apart from `start`, each the mean of the samples
 * the bucket holds. NaN where a bucket holds none, which the chart draws as a gap.
 */
export type PopulationView = {
	range: ClientOnlySettings.PopulationRange
	start: number
	end: number
	bucketMs: number
	total: number[]
	active: number[]
	idle: number[]
	sides: [number[], number[]]
	sideDisplays: [TeamDisplay, TeamDisplay]
	// [from, to) for each run of buckets holding samples, so the chart breaks its lines at the gaps
	runs: [number, number][]
	bands: PopulationBand[]
	pending: number
	idleMinutes: number
	// the player count that counts as full
	cap: number
	stats: PopulationStats
}

/**
 * Figures over everything a population view covers. Per-bucket means stand in for samples where a range averages
 * them, which makes the median approximate there; the peak, low and team gaps come from per-bucket extremes and are
 * exact. Null fields have no samples to come from.
 */
export type PopulationStats = {
	peak: { value: number; at: number } | null
	low: { value: number; at: number } | null
	average: number | null
	median: number | null
	// share of the sampled time at or above the player cap, 0 to 1
	fullShare: number | null
	// share of the players who were idle, on average, 0 to 1
	idleShare: number | null
	gapAverage: number | null
	gapMax: number | null
	joinsPerHour: number | null
	leavesPerHour: number | null
	// leaves per hour over the average player count: the share of the server that turns over in an hour
	churnPerHour: number | null
	// the matches with samples in the view; null for a single match
	matches: number | null
}

function populationStats(buckets: Pop.Buckets, idleRow: number, bands: PopulationBand[] | null): PopulationStats {
	let samples = 0
	let totalSum = 0
	let idleSum = 0
	let gapSum = 0
	let gapMax: number | null = null
	let full = 0
	let joins = 0
	let leaves = 0
	let peak: PopulationStats['peak'] = null
	let low: PopulationStats['low'] = null
	const means: { value: number; weight: number }[] = []
	for (let i = 0; i < buckets.n.length; i++) {
		const n = buckets.n[i]
		if (n === 0) continue
		const at = buckets.start + i * buckets.bucketMs
		samples += n
		totalSum += buckets.total[i]
		idleSum += buckets.idle[idleRow][i]
		gapSum += buckets.gap[i]
		gapMax = Math.max(gapMax ?? 0, buckets.gapMax[i])
		full += buckets.full[i]
		joins += buckets.joins[i]
		leaves += buckets.leaves[i]
		if (!peak || buckets.max[i] > peak.value) peak = { value: buckets.max[i], at }
		if (!low || buckets.min[i] < low.value) low = { value: buckets.min[i], at }
		means.push({ value: buckets.total[i] / n, weight: n })
	}
	if (samples === 0) {
		return {
			peak: null,
			low: null,
			average: null,
			median: null,
			fullShare: null,
			idleShare: null,
			gapAverage: null,
			gapMax: null,
			joinsPerHour: null,
			leavesPerHour: null,
			churnPerHour: null,
			matches: bands ? 0 : null,
		}
	}
	means.sort((a, b) => a.value - b.value)
	let median = means[means.length - 1].value
	for (let acc = 0, j = 0; j < means.length; j++) {
		acc += means[j].weight
		if (acc * 2 >= samples) {
			median = means[j].value
			break
		}
	}
	const average = totalSum / samples
	const hours = (samples * Pop.SAMPLE_STEP_MS) / 3_600_000
	const leavesPerHour = leaves / hours
	const sampled = (band: PopulationBand) => {
		const from = Math.max(0, Math.floor((band.start - buckets.start) / buckets.bucketMs))
		const to = Math.min(buckets.n.length, Math.ceil((band.end - buckets.start) / buckets.bucketMs))
		for (let i = from; i < to; i++) if (buckets.n[i] > 0) return true
		return false
	}
	return {
		peak,
		low,
		average,
		median,
		fullShare: full / samples,
		idleShare: totalSum > 0 ? idleSum / totalSum : 0,
		gapAverage: gapSum / samples,
		gapMax,
		joinsPerHour: joins / hours,
		leavesPerHour,
		churnPerHour: average > 0 ? leavesPerHour / average : null,
		matches: bands ? bands.filter(sampled).length : null,
	}
}

// where a run of samples stops, or undefined when there are none
function samplesEnd(samples: Pop.Samples): number | undefined {
	const last = samples[samples.length - 1]
	return last ? last.start + last.total.length * Pop.SAMPLE_STEP_MS : undefined
}

// a match's name on the population chart: its map and gamemode, which is what fits above a band
function layerLabel(layerId: string): string {
	const layer = L.toLayer(layerId)
	return L.isKnownLayer(layer) ? `${layer.Map} ${layer.Gamemode}` : layerId
}

function toView(
	range: ClientOnlySettings.PopulationRange,
	buckets: Pop.Buckets,
	bands: PopulationBand[],
	pending: number,
	sideDisplays: [TeamDisplay, TeamDisplay],
	sideKeys: ['team1' | 'teamA', 'team2' | 'teamB'],
	idleRow: number,
	idleMinutes: number,
	cap: number,
): PopulationView {
	const mean = (sums: number[]) => sums.map((sum, i) => (buckets.n[i] > 0 ? sum / buckets.n[i] : NaN))
	const total = mean(buckets.total)
	const idle = mean(buckets.idle[idleRow])
	const runs: [number, number][] = []
	let from = -1
	for (let i = 0; i <= total.length; i++) {
		const has = i < total.length && buckets.n[i] > 0
		if (has && from === -1) from = i
		if (!has && from !== -1) {
			runs.push([from, i])
			from = -1
		}
	}
	return {
		range,
		start: buckets.start,
		end: buckets.start + buckets.n.length * buckets.bucketMs,
		bucketMs: buckets.bucketMs,
		total,
		idle,
		active: total.map((value, i) => value - idle[i]),
		sides: [mean(buckets[sideKeys[0]]), mean(buckets[sideKeys[1]])],
		sideDisplays,
		runs,
		bands,
		pending,
		idleMinutes,
		cap,
		stats: populationStats(buckets, idleRow, range === 'match' ? null : bands),
	}
}

export type Scoreline = {
	stats: MH.MatchCombatStats
	// each team's tickets once the round has ended with a result
	tickets: [number, number] | null
	winner: SM.TeamId | null
	chart: { series: Chart.LineSeries[]; xMax: number; signed: boolean }
}

export type Breakdown = {
	series: Chart.Series[]
	rows: Chart.Row[]
	// who is behind each bar segment, indexed [rowIndex][seriesIndex]. Carries ids as well as names because a
	// segment is clickable: what it selects is exactly what it counted.
	members: BreakdownMember[][][]
	// the series label of the players outside every group, which reads differently per grouping mode
	ungroupedLabel: string
}

export namespace Sel {
	type TeamInputs = [
		store: ChatPrt.Store,
		currentMatch: MH.MatchDetails | undefined,
		recentMatches: readonly MH.MatchDetails[],
		clientSettings: ClientOnlySettingsStore,
	]
	type BreakdownInputs = [...TeamInputs, bmData: BM.PublicPlayerBmData, bmStore: BM.StoreState, settings: PublicSettings | undefined]

	const displayMatch = (...[store, currentMatch, recentMatches]: TeamInputs) =>
		ChatPrt.Sel.displayMatch(store, currentMatch, recentMatches)
	const teamInputs = (args: BreakdownInputs) => args.slice(0, 4) as TeamInputs

	// how the two teams are named and coloured for this match: raw slots, or normalized to A/B by the match's parity
	export const teams = RSel.createDeepSelector(
		[
			(...args: TeamInputs) => displayMatch(...args)?.layerId,
			(...args: TeamInputs) => displayMatch(...args)?.ordinal,
			(...[, , , clientSettings]: TeamInputs) => clientSettings.displayTeamsNormalized,
		],
		(layerId, ordinal, normalized): [TeamDisplay, TeamDisplay] => {
			const layer = layerId ? L.toLayer(layerId) : null
			const factions = layer && L.isKnownLayer(layer) ? [layer.Faction_1, layer.Faction_2] : [null, null]
			if (!normalized) {
				return [
					{ label: I18n.ambient.text(L_Msgs.teamName(1, factions[0])), color: DH.TEAM_COLORS.team1 },
					{ label: I18n.ambient.text(L_Msgs.teamName(2, factions[1])), color: DH.TEAM_COLORS.team2 },
				]
			}
			const parity = ordinal ?? 0
			const normedLabels = ['A', 'B'] as const
			const normedColors = [DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB]
			return ([1, 2] as const).map((teamId) => {
				const normedIdx = (parity + teamId - 1) % 2
				return {
					label: I18n.ambient.text(L_Msgs.teamName(normedLabels[normedIdx], factions[teamId - 1])),
					color: normedColors[normedIdx],
				}
			}) as [TeamDisplay, TeamDisplay]
		},
	)

	// The current match's scoreline, tallied by the chat state as the match plays. A finished match carries its own,
	// computed once on the server, so this is only ever the match still in progress.
	export function liveCombatStats(...[store, currentMatch]: TeamInputs): MH.MatchCombatStats | null {
		const matchId = currentMatch?.historyEntryId
		if (matchId === undefined) return null
		const tally = store.chat.chatState.combatTally
		return tally?.matchId === matchId ? tally.stats : MH.EMPTY_COMBAT_STATS
	}

	const groupingIds = RSel.createDeepSelector(
		[(...[, , , , , , settings]: BreakdownInputs) => settings?.playerGroupings],
		(playerGroupings) => PG.groupingIdsWithParty(playerGroupings ?? PG.EMPTY_PLAYER_GROUPINGS),
	)

	const activeGroupingId = RSel.createSelector(
		[groupingIds, (...[, , , , , bmStore]: BreakdownInputs) => bmStore.selectedGroupingId],
		(ids, selected) => (selected !== null && ids.includes(selected) ? selected : (ids[0] ?? null)),
	)

	// what the grouping switcher above the chart renders: every configured grouping, and the one in effect
	export const groupings = RSel.createDeepSelector([groupingIds, activeGroupingId], (ids, active) => ({ ids, active }))

	// Team attribution replayed from a historical match's events, parameterised like combatStats: the events arrive
	// from a query, not a store.
	export const attribution = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createSelector(
			[(...[, , , , , , settings]: BreakdownInputs) => settings?.teamAttribution],
			(config): TA.MatchAttribution | null =>
				historicalEvents ? TA.computeTeamAttribution(historicalEvents, config ?? TA.DEFAULT_SETTINGS) : null,
		),
	)

	// The roster split by team and by the active grouping: the live roster for the current match, or the attributed
	// roster (minus carved-out players) replayed from a historical match's events. The historical chart is absent
	// rather than empty until those events load.
	export const breakdown = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createDeepSelector(
			[
				(...[store]: BreakdownInputs) => ChatPrt.Sel.selectedMatchOrdinal(store),
				(...[store]: BreakdownInputs) => ChatPrt.Sel.players(store),
				attribution(historicalEvents),
				(...[, , , , bmData]: BreakdownInputs) => bmData,
				(...[, , , , , bmStore]: BreakdownInputs) => bmStore.slsOnly,
				(...[, , , , , bmStore]: BreakdownInputs) => bmStore.orgFlags,
				(...[, , , , , , settings]: BreakdownInputs) => settings?.playerGroupings,
				activeGroupingId,
				(...args: BreakdownInputs) => teams(...teamInputs(args)),
			],
			(selectedOrdinal, players, attributed, bmData, slsOnly, orgFlags, playerGroupings, groupingId, teamDisplays): Breakdown | null => {
				if (groupingId === null) return null
				const groupings = playerGroupings ?? PG.EMPTY_PLAYER_GROUPINGS

				// each roster entry with the team row it counts for; historical entries carry the team the player
				// spent the most time on rather than the one they happened to occupy last
				let roster: { player: SM.Player; teamId: SM.TeamId | null }[]
				if (selectedOrdinal !== null) {
					if (!attributed) return null
					roster = attributed.players.filter((p) => p.eligible).map((p) => ({ player: p.player, teamId: p.primaryTeamId }))
				} else {
					roster = players.map((p) => ({ player: p, teamId: p.teamId }))
				}
				if (slsOnly) roster = roster.filter((p) => p.player.isLeader)

				// bmData is keyed by EOS id, so players without one can only fall into the ungrouped series
				const playerFacts: [SM.PlayerId, PG.PlayerFacts][] = roster
					.filter((p) => p.player.ids.eos != null)
					.map((p) => [
						p.player.ids.eos!,
						PG.playerFacts(p.player, BM.resolveFlags(bmData[p.player.ids.eos!]?.flagIds ?? [], orgFlags)),
					])
				const groups = PG.resolvePlayerGroups(playerFacts, groupings, groupingId)

				const ungrouped = I18n.ambient.text(PG_Msgs.ungroupedIn(groupingId))
				const labels = [...PG.groupNamesOf(groupings, groupingId, groups.values()), ungrouped]
				const labelToIdx = new Map(labels.map((label, i) => [label, i]))
				const ungroupedIdx = labels.length - 1
				const counts = [labels.map(() => 0), labels.map(() => 0)]
				const members: BreakdownMember[][][] = [labels.map((): BreakdownMember[] => []), labels.map((): BreakdownMember[] => [])]

				for (const { player, teamId } of roster) {
					const rowIndex = (teamId ?? 0) - 1
					if (rowIndex !== 0 && rowIndex !== 1) continue
					const group = player.ids.eos != null ? groups.get(player.ids.eos) : undefined
					const seriesIndex = group != null ? (labelToIdx.get(group) ?? -1) : ungroupedIdx
					if (seriesIndex === -1) continue
					counts[rowIndex][seriesIndex]++
					members[rowIndex][seriesIndex].push({
						id: SM.PlayerIds.getPlayerId(player.ids),
						name: player.ids.usernameNoTag ?? player.ids.username ?? player.ids.steam ?? '?',
					})
				}

				return {
					series: labels.map((label) => ({
						key: label,
						label,
						color: label === ungrouped ? PG.DEFAULT_GROUP_COLOR : PG.groupColorOf(groupings, groupingId, label, orgFlags),
					})),
					rows: teamDisplays.map((team, rowIndex) => ({ key: `team${rowIndex + 1}`, label: team.label, values: counts[rowIndex] })),
					members,
					ungroupedLabel: ungrouped,
				}
			},
		),
	)

	// The live match's timeline, or the replayed one once its events have loaded. Null until there is one to show.
	const timeline = RSel.memoizeFactory(
		(historicalEvents: CHAT.EventEnriched[] | null) =>
			(...[store, currentMatch]: TeamInputs): ScorelineTimeline | null => {
				if (ChatPrt.Sel.selectedMatchOrdinal(store) !== null) return historicalEvents ? historicalTimeline(historicalEvents) : null
				const matchId = currentMatch?.historyEntryId
				return matchId === undefined ? null : liveTimeline(store.chat.chatState, matchId)
			},
	)

	// The displayed match's scoreline: the totals, the tickets once the round is over, and the chosen metric over time.
	export const scoreline = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createSelector(
			[
				timeline(historicalEvents),
				displayMatch,
				teams,
				(...[, , , clientSettings]: TeamInputs) => ClientOnlySettings.Sel.scorelineMetric(clientSettings),
			],
			(timeline, match, teamDisplays, metric): Scoreline | null => {
				if (!timeline || !match) return null
				const stats: MH.MatchCombatStats = {
					team1: { kills: timeline.kills[0].length, wounds: timeline.wounds[0], deaths: timeline.deaths[0].length },
					team2: { kills: timeline.kills[1].length, wounds: timeline.wounds[1], deaths: timeline.deaths[1].length },
				}

				let tickets: [number, number] | null = null
				let winner: SM.TeamId | null = null
				if (match.status === 'post-game' && (match.outcome.type === 'team1' || match.outcome.type === 'team2')) {
					tickets = [match.outcome.team1Tickets, match.outcome.team2Tickets]
					winner = match.outcome.type === 'team1' ? 1 : 2
				}

				let firstEvent = Infinity
				let lastEvent = -Infinity
				for (const times of [...timeline.kills, ...timeline.deaths]) {
					if (times.length === 0) continue
					firstEvent = Math.min(firstEvent, times[0])
					lastEvent = Math.max(lastEvent, times[times.length - 1])
				}
				const start = match.startTime?.getTime() ?? (Number.isFinite(firstEvent) ? firstEvent : 0)
				const end = match.status === 'post-game' && match.endTime instanceof Date ? match.endTime.getTime() : lastEvent
				const xMax = Math.max(end - start, lastEvent - start, 60_000)

				let series: Chart.LineSeries[]
				switch (metric) {
					case 'kills':
					case 'deaths': {
						const times = metric === 'kills' ? timeline.kills : timeline.deaths
						series = teamDisplays.map((team, i) => ({
							key: `team${i + 1}`,
							label: team.label,
							color: team.color,
							points: cumulative(times[i], start),
						}))
						break
					}
					case 'lead':
						series = [
							{ key: 'lead', label: teamDisplays[0].label, color: teamDisplays[0].color, points: killLead(timeline.kills, start) },
						]
						break
					default:
						assertNever(metric)
				}

				return { stats, tickets, winner, chart: { series, xMax, signed: metric === 'lead' } }
			},
		),
	)

	type PopulationInputs = [...TeamInputs, settings: PublicSettings | undefined, serverInfo: SM.ServerInfo | null]
	const populationTeamInputs = (args: PopulationInputs) => args.slice(0, 4) as TeamInputs

	// The displayed match's samples: replayed once a past match's events load, or the live match's. Null until then.
	const displayedSamples = RSel.memoizeFactory(
		(historicalEvents: CHAT.EventEnriched[] | null) =>
			(...[store, currentMatch]: PopulationInputs): Pop.Samples | null => {
				if (ChatPrt.Sel.selectedMatchOrdinal(store) !== null) return historicalEvents ? Pop.replay(historicalEvents) : null
				const matchId = currentMatch?.historyEntryId
				return matchId === undefined ? null : Pop.live(store.chat.chatState, matchId)
			},
	)

	const liveSamples = (...[store, currentMatch]: PopulationInputs): Pop.Samples => {
		const matchId = currentMatch?.historyEntryId
		return matchId === undefined ? [] : Pop.live(store.chat.chatState, matchId)
	}

	const idleStep = (...[, , , , settings]: PopulationInputs) =>
		settings?.playerActivity.idleThresholdMinutes ?? Activity.DEFAULT_SETTINGS.idleThresholdMinutes

	const normalized = (...[, , , clientSettings]: PopulationInputs) => clientSettings.displayTeamsNormalized

	export const playerCap = (...[, , , , , serverInfo]: PopulationInputs) => serverInfo?.maxPlayerCount || Pop.DEFAULT_MAX_PLAYERS

	// A range's teams have no factions to name, since every match in it has its own.
	function rangeSides(normalized: boolean): [TeamDisplay, TeamDisplay] {
		return normalized
			? [
					{ label: I18n.ambient.text(L_Msgs.teamName('A', null)), color: DH.TEAM_COLORS.teamA },
					{ label: I18n.ambient.text(L_Msgs.teamName('B', null)), color: DH.TEAM_COLORS.teamB },
				]
			: [
					{ label: I18n.ambient.text(L_Msgs.teamName(1, null)), color: DH.TEAM_COLORS.team1 },
					{ label: I18n.ambient.text(L_Msgs.teamName(2, null)), color: DH.TEAM_COLORS.team2 },
				]
	}

	/**
	 * The population chart: the displayed match on its own, or every match in the last 6 hours, day or week. Null while
	 * the data loads. A range draws the server's stored matches with the live match added from the live feed.
	 */
	export const population = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null, rangeData: Pop.RangeData | null) =>
		RSel.createSelector(
			[
				(...[, , , clientSettings]: PopulationInputs) => ClientOnlySettings.Sel.populationRange(clientSettings),
				displayedSamples(historicalEvents),
				liveSamples,
				(...args: PopulationInputs) => displayMatch(...populationTeamInputs(args)),
				(...[, currentMatch]: PopulationInputs) => currentMatch,
				(...[store]: PopulationInputs) => ChatPrt.Sel.selectedMatchOrdinal(store),
				(...args: PopulationInputs) => teams(...populationTeamInputs(args)),
				normalized,
				idleStep,
				playerCap,
			],
			(range, displayed, live, match, currentMatch, selectedOrdinal, teamDisplays, normalized, step, cap): PopulationView | null => {
				const idleRow = Pop.idleStepIndex(step)
				if (range === 'match') {
					if (!displayed || !match) return null
					const firstSample = displayed[0]?.start
					const start = match.startTime?.getTime() ?? firstSample ?? Date.now()
					const end = Math.max(samplesEnd(displayed) ?? start, start + 60_000)
					const buckets = Pop.emptyBuckets(start, end, Pop.SAMPLE_STEP_MS)
					Pop.addToBuckets(buckets, displayed, match.ordinal, cap)
					const roundEnd = match.status === 'post-game' && match.endTime instanceof Date ? match.endTime.getTime() : null
					const band: PopulationBand = {
						ordinal: match.ordinal,
						label: layerLabel(match.layerId),
						start,
						roundEnd,
						end,
						displayed: true,
					}
					return toView(range, buckets, [band], 0, teamDisplays, ['team1', 'team2'], idleRow, step, cap)
				}

				if (!rangeData) return null
				const server = rangeData.buckets
				const serverEnd = server.start + server.n.length * server.bucketMs
				const end = Math.max(serverEnd, samplesEnd(live) ?? 0)
				const liveBuckets = Pop.emptyBuckets(server.start, end, server.bucketMs)
				if (currentMatch) Pop.addToBuckets(liveBuckets, live, currentMatch.ordinal, cap)
				const merged = Pop.mergeBuckets(liveBuckets, server)
				const bands: PopulationBand[] = rangeData.bands.map((band) => ({
					ordinal: band.ordinal,
					label: layerLabel(band.layerId),
					start: band.start,
					roundEnd: band.roundEnd,
					end,
					displayed: false,
				}))
				if (currentMatch) {
					bands.push({
						ordinal: currentMatch.ordinal,
						label: layerLabel(currentMatch.layerId),
						start: (currentMatch.startTime ?? currentMatch.createdAt)?.getTime() ?? live[0]?.start ?? end,
						roundEnd:
							currentMatch.status === 'post-game' && currentMatch.endTime instanceof Date ? currentMatch.endTime.getTime() : null,
						end,
						displayed: false,
					})
				}
				bands.sort((a, b) => a.start - b.start)
				const shown = selectedOrdinal ?? currentMatch?.ordinal
				for (let i = 0; i < bands.length; i++) {
					bands[i].end = bands[i + 1]?.start ?? end
					bands[i].displayed = bands[i].ordinal === shown
				}
				return toView(
					range,
					merged,
					bands.filter((band) => band.end > merged.start),
					rangeData.pending,
					rangeSides(normalized),
					normalized ? ['teamA', 'teamB'] : ['team1', 'team2'],
					idleRow,
					step,
					cap,
				)
			},
		),
	)

	// whether the panel has a chart to draw, so it can show its empty state without every child duplicating the
	// question
	export const hasData = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createSelector([breakdown(historicalEvents)], (breakdown) => breakdown !== null),
	)
}
