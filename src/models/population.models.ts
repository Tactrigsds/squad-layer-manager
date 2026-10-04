// Player population over time, by team and by activity. One sampler replays a match's roster and activity events
// into samples SAMPLE_STEP_MS apart. The live chart runs it over the chat buffer, and the server stores each
// finished match's samples (see match-tallies.server.ts), so a chart spanning days of matches never replays them.
//
// Who counts as idle is player-activity.models.ts's rule. A sample counts players against every threshold the
// setting offers.
import * as CHAT from '@/models/chat.models'
import * as Activity from '@/models/player-activity.models'
import * as SM from '@/models/squad.models'

export const SAMPLE_STEP_MS = 30_000

const IDLE_STEPS_MIN = Activity.IDLE_STEPS_MIN

// Stored samples carry the version that produced them. Bump it when the sampling rules change, and the backfill
// recomputes every stored match.
export const SAMPLER_VERSION = 2

/**
 * Consecutive samples SAMPLE_STEP_MS apart, the first at `start` (ms since the epoch). Columnar, since one is
 * stored per match. `idle[k][i]` counts the players idle at sample i under the threshold IDLE_STEPS_MIN[k], so each
 * row is a subset of the one before it. `joins[i]` and `leaves[i]` count the players who connected and disconnected
 * since the sample before; a roster restated at a match start or a reconnect counts as neither.
 */
export type Run = {
	start: number
	team1: number[]
	team2: number[]
	total: number[]
	idle: number[][]
	joins: number[]
	leaves: number[]
}

// A match's samples. A match has several runs when SLM lost its RCON connection partway through: nothing is known
// about the roster between a disconnect and the roster the reconnect restates.
export type Samples = Run[]

// the row of `Run.idle` that counts players under `step`
export function idleStepIndex(step: Activity.IdleStep): number {
	return IDLE_STEPS_MIN.indexOf(step)
}

// what the sampler needs of each player on the roster, besides when they last acted
type Tracked = { teamId: SM.TeamId | null } & Activity.IdleFacts

type Sampler = {
	players: Map<SM.PlayerId, Tracked>
	activity: Activity.Tracker
	runs: Run[]
	// the next grid time to sample, or null while the roster is unknown
	nextAt: number | null
	// connects and disconnects since the last sample
	joins: number
	leaves: number
}

function createSampler(): Sampler {
	return { players: new Map(), activity: Activity.init(), runs: [], nextAt: null, joins: 0, leaves: 0 }
}

const IDLE_MS = IDLE_STEPS_MIN.map((minutes) => minutes * 60_000)

function takeSample(sampler: Sampler, at: number) {
	let run = sampler.runs[sampler.runs.length - 1]
	if (!run || run.start + run.total.length * SAMPLE_STEP_MS !== at) {
		run = { start: at, team1: [], team2: [], total: [], idle: IDLE_STEPS_MIN.map(() => []), joins: [], leaves: [] }
		sampler.runs.push(run)
	}
	let team1 = 0
	let team2 = 0
	const idle = IDLE_MS.map(() => 0)
	for (const [id, player] of sampler.players) {
		if (player.teamId === 1) team1++
		else if (player.teamId === 2) team2++
		if (!Activity.canIdle(player)) continue
		const quietFor = at - (sampler.activity.lastActive.get(id) ?? at)
		for (let k = 0; k < IDLE_MS.length && quietFor >= IDLE_MS[k]; k++) idle[k]++
	}
	run.team1.push(team1)
	run.team2.push(team2)
	run.total.push(sampler.players.size)
	for (let k = 0; k < idle.length; k++) run.idle[k].push(idle[k])
	run.joins.push(sampler.joins)
	run.leaves.push(sampler.leaves)
	sampler.joins = 0
	sampler.leaves = 0
}

// Samples every grid time before `time`, which the events applied so far describe.
function sampleUntil(sampler: Sampler, time: number) {
	if (sampler.nextAt === null) return
	for (; sampler.nextAt < time; sampler.nextAt += SAMPLE_STEP_MS) takeSample(sampler, sampler.nextAt)
}

function startSampling(sampler: Sampler, time: number) {
	sampler.nextAt ??= Math.ceil(time / SAMPLE_STEP_MS) * SAMPLE_STEP_MS
}

function tracked(sampler: Sampler, player: SM.Player): Tracked | undefined {
	return sampler.players.get(SM.PlayerIds.getPlayerId(player.ids))
}

function place(sampler: Sampler, player: SM.Player) {
	sampler.players.set(SM.PlayerIds.getPlayerId(player.ids), { teamId: player.teamId, squadId: player.squadId, vehicle: player.vehicle })
}

function restateRoster(sampler: Sampler, players: readonly SM.Player[], time: number) {
	sampler.players.clear()
	for (const player of players) place(sampler, player)
	startSampling(sampler, time)
}

function applyEvent(sampler: Sampler, event: CHAT.EventEnriched) {
	Activity.note(sampler.activity, event)
	const time = event.time
	switch (event.type) {
		case 'RESET':
			restateRoster(sampler, event.state.players, time)
			break
		case 'NEW_GAME':
			// legacy matches carried the initial roster here; see server-events.models.ts
			if (event.state) restateRoster(sampler, event.state.players, time)
			break
		case 'RCON_DISCONNECTED':
			sampler.nextAt = null
			break
		case 'PLAYER_CONNECTED':
		case 'PLAYER_RECONCILED':
		case 'PLAYER_DETAILS_CHANGED':
			// a reconciled player SLM had not seen connect still arrived, as far as the roster can tell
			if (event.type !== 'PLAYER_DETAILS_CHANGED' && sampler.nextAt !== null && !tracked(sampler, event.player)) sampler.joins++
			// the enriched player is the roster's view after the event, squad and vehicle included
			place(sampler, event.player)
			if (event.type !== 'PLAYER_DETAILS_CHANGED') startSampling(sampler, time)
			break
		case 'PLAYER_DISCONNECTED':
			if (sampler.players.delete(SM.PlayerIds.getPlayerId(event.player.ids)) && sampler.nextAt !== null) sampler.leaves++
			break
		case 'PLAYER_CHANGED_TEAM': {
			const entry = tracked(sampler, event.player)
			if (!entry) break
			entry.teamId = event.newTeamId
			entry.squadId = null
			break
		}
		case 'SQUAD_CREATED': {
			const entry = sampler.players.get(event.squad.creator)
			if (entry) entry.squadId = event.squad.squadId
			break
		}
		case 'PLAYER_JOINED_SQUAD': {
			const entry = tracked(sampler, event.player)
			if (entry) entry.squadId = event.squad.squadId
			break
		}
		case 'PLAYER_LEFT_SQUAD': {
			const entry = tracked(sampler, event.player)
			if (entry) entry.squadId = null
			break
		}
		case 'SQUAD_DISBANDED':
			for (const entry of sampler.players.values()) {
				if (entry.teamId === event.squad.teamId && entry.squadId === event.squad.squadId) entry.squadId = null
			}
			break
		default:
			break
	}
}

function step(sampler: Sampler, event: CHAT.EventEnriched) {
	sampleUntil(sampler, event.time)
	applyEvent(sampler, event)
}

/**
 * A finished match's samples, through its last event. The last sample is the roster after that event, at the next
 * grid time, as the live tracker's provisional one is: without it a match shorter than a step would have none.
 */
export function sampleMatch(events: readonly CHAT.EventEnriched[]): Samples {
	const sampler = createSampler()
	const ordered = CHAT.serverEventsInOrder(events)
	for (const event of ordered) step(sampler, event)
	if (sampler.nextAt !== null) takeSample(sampler, sampler.nextAt)
	return sampler.runs
}

const replayed = new WeakMap<readonly CHAT.EventEnriched[], Samples>()

// A past match's samples, built once per fetched event list.
export function replay(events: readonly CHAT.EventEnriched[]): Samples {
	let samples = replayed.get(events)
	if (!samples) {
		samples = sampleMatch(events)
		replayed.set(events, samples)
	}
	return samples
}

function copyRuns(runs: readonly Run[]): Run[] {
	return runs.map((run) => ({
		start: run.start,
		team1: [...run.team1],
		team2: [...run.team2],
		total: [...run.total],
		idle: run.idle.map((row) => [...row]),
		joins: [...run.joins],
		leaves: [...run.leaves],
	}))
}

// whether two sample runs hold the same samples
function sameRuns(a: readonly Run[], b: readonly Run[]) {
	if (a.length !== b.length) return false
	for (let r = 0; r < a.length; r++) {
		const x = a[r]
		const y = b[r]
		if (x.start !== y.start || x.total.length !== y.total.length) return false
		const last = x.total.length - 1
		if (last < 0) continue
		if (x.total[last] !== y.total[last] || x.team1[last] !== y.team1[last] || x.team2[last] !== y.team2[last]) return false
		if (x.joins[last] !== y.joins[last] || x.leaves[last] !== y.leaves[last]) return false
		for (let k = 0; k < x.idle.length; k++) if (x.idle[k][last] !== y.idle[k][last]) return false
	}
	return true
}

/**
 * The live match's samples, scanning only the buffer entries appended since the previous call, like the scoreline's
 * tracker in stats-panel.models.ts. An entry collapsed under an APP_EVENT after the fact bumps the buffer's epoch,
 * so the rescan that follows replays it in order.
 *
 * The samples end with a provisional one at the next grid time, taken from the roster as it is now: a sample is only
 * final once an event lands after its time, and without it the chart would trail the server by up to a step. The
 * result keeps its identity until a sample changes.
 */
function createTracker() {
	let buffer: CHAT.EventEnriched[] | null = null
	let epoch = -1
	let scanned = 0
	let trackedMatchId = -1
	let sampler = createSampler()
	let result: Samples = []
	return (state: CHAT.ChatState, matchId: number): Samples => {
		let pending: readonly CHAT.EventEnriched[]
		if (state.eventBuffer !== buffer || state.bufferEpoch !== epoch || state.eventBuffer.length < scanned || matchId !== trackedMatchId) {
			buffer = state.eventBuffer
			epoch = state.bufferEpoch
			trackedMatchId = matchId
			sampler = createSampler()
			result = []
			pending = CHAT.serverEventsInOrder(state.eventBuffer)
		} else {
			pending = CHAT.serverEventsInOrder(state.eventBuffer.slice(scanned))
		}
		scanned = state.eventBuffer.length

		let stepped = false
		for (const event of pending) {
			if (event.matchId !== matchId) continue
			step(sampler, event)
			stepped = true
		}
		if (!stepped && result.length > 0) return result
		// the sampler keeps writing its own runs, so what is handed out is a copy
		const next = copyRuns(sampler.runs)
		if (sampler.nextAt !== null) takeSample({ ...sampler, runs: next }, sampler.nextAt)
		if (!sameRuns(next, result)) result = next
		return result
	}
}

const liveTrackers = new WeakMap<CHAT.EventEnriched[], ReturnType<typeof createTracker>>()

export function live(state: CHAT.ChatState, matchId: number): Samples {
	let track = liveTrackers.get(state.eventBuffer)
	if (!track) {
		track = createTracker()
		liveTrackers.set(state.eventBuffer, track)
	}
	return track(state, matchId)
}

// the player cap a server that reports none is taken to have
export const DEFAULT_MAX_PLAYERS = 100

// the population chart's colours for active players, the hatch over idle ones, and the total line
export const COLORS = { active: '#3987e5', idleStroke: '#7fb0f0', total: '#8fbaf2' }

// ---- ranges ----

export const RANGES = ['6h', '24h', '7d'] as const
export type Range = (typeof RANGES)[number]

export const RANGE_MS: Record<Range, number> = { '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000 }

// how much time each point of a range's chart averages over
export const BUCKET_MS: Record<Range, number> = { '6h': 60_000, '24h': 5 * 60_000, '7d': 30 * 60_000 }

/**
 * Sums of samples per bucket, the first starting at `start`, each `bucketMs` long. `n[i]` is how many samples
 * bucket i holds: its mean is a sum over its n, and an empty bucket is a gap. Sums rather than means so the
 * server's stored matches and the client's live match merge by adding.
 *
 * `teamA` and `teamB` are the teams normalized by each match's ordinal parity, which only a per-match sum can do.
 * `max` and `min` are the bucket's highest and lowest total, so a peak survives the averaging, and `min` is EMPTY_MIN
 * in an empty bucket. `gap` sums the difference between the teams, `gapMax` holds its largest, and `full` counts the
 * samples at or above the player cap.
 */
export type Buckets = {
	start: number
	bucketMs: number
	n: number[]
	total: number[]
	team1: number[]
	team2: number[]
	teamA: number[]
	teamB: number[]
	idle: number[][]
	max: number[]
	min: number[]
	gap: number[]
	gapMax: number[]
	full: number[]
	joins: number[]
	leaves: number[]
}

export const EMPTY_MIN = Number.MAX_SAFE_INTEGER

export function emptyBuckets(start: number, end: number, bucketMs: number): Buckets {
	const count = Math.max(0, Math.ceil((end - start) / bucketMs))
	const zeros = () => new Array<number>(count).fill(0)
	return {
		start,
		bucketMs,
		n: zeros(),
		total: zeros(),
		team1: zeros(),
		team2: zeros(),
		teamA: zeros(),
		teamB: zeros(),
		idle: IDLE_STEPS_MIN.map(zeros),
		max: zeros(),
		min: new Array<number>(count).fill(EMPTY_MIN),
		gap: zeros(),
		gapMax: zeros(),
		full: zeros(),
		joins: zeros(),
		leaves: zeros(),
	}
}

/**
 * Adds a match's samples into `buckets`, in place. `parity` is the match's ordinal, which decides which raw team is
 * Team A (see MH.getNormedTeamId). `cap` is the player count that counts as full.
 */
export function addToBuckets(buckets: Buckets, samples: Samples, parity: number, cap: number) {
	const team1IsA = parity % 2 === 0
	const count = buckets.n.length
	for (const run of samples) {
		for (let i = 0; i < run.total.length; i++) {
			const b = Math.floor((run.start + i * SAMPLE_STEP_MS - buckets.start) / buckets.bucketMs)
			if (b < 0 || b >= count) continue
			const total = run.total[i]
			const gap = Math.abs(run.team1[i] - run.team2[i])
			buckets.n[b]++
			buckets.total[b] += total
			buckets.team1[b] += run.team1[i]
			buckets.team2[b] += run.team2[i]
			buckets.teamA[b] += team1IsA ? run.team1[i] : run.team2[i]
			buckets.teamB[b] += team1IsA ? run.team2[i] : run.team1[i]
			for (let k = 0; k < run.idle.length; k++) buckets.idle[k][b] += run.idle[k][i]
			if (total > buckets.max[b]) buckets.max[b] = total
			if (total < buckets.min[b]) buckets.min[b] = total
			buckets.gap[b] += gap
			if (gap > buckets.gapMax[b]) buckets.gapMax[b] = gap
			if (total >= cap) buckets.full[b]++
			buckets.joins[b] += run.joins[i]
			buckets.leaves[b] += run.leaves[i]
		}
	}
}

// A match as a range's chart marks it: a solid line where it started, a dashed one where its round ended.
export type Band = { ordinal: number; layerId: string; start: number; roundEnd: number | null }

/**
 * A range's chart from the server: every finished match in it, bucketed, and their bands. `pending` counts the
 * finished matches in the range whose samples the backfill has not stored yet. The current match is the client's
 * to add, from its live feed.
 */
export type RangeData = { buckets: Buckets; bands: Band[]; pending: number }

// `into` plus `other`, which covers the same buckets
export function mergeBuckets(into: Buckets, other: Buckets): Buckets {
	const add = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0))
	const most = (a: number[], b: number[]) => a.map((v, i) => Math.max(v, b[i] ?? 0))
	const least = (a: number[], b: number[]) => a.map((v, i) => Math.min(v, b[i] ?? EMPTY_MIN))
	return {
		...into,
		n: add(into.n, other.n),
		total: add(into.total, other.total),
		team1: add(into.team1, other.team1),
		team2: add(into.team2, other.team2),
		teamA: add(into.teamA, other.teamA),
		teamB: add(into.teamB, other.teamB),
		idle: into.idle.map((row, k) => add(row, other.idle[k])),
		max: most(into.max, other.max),
		min: least(into.min, other.min),
		gap: add(into.gap, other.gap),
		gapMax: most(into.gapMax, other.gapMax),
		full: add(into.full, other.full),
		joins: add(into.joins, other.joins),
		leaves: add(into.leaves, other.leaves),
	}
}
