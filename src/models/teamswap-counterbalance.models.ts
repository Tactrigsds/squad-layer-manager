// Counterbalance: after an admin edits the queued teamswaps, pick swaps from the other side that bring the team sizes
// as close to even as the configured rules allow. The client re-picks against the edit set on every admin edit. The
// server re-picks against the saved swaps when roster changes leave them uneven for `rosterChangeDelay`.
//
// Players are picked in units. A unit is a party's members on the larger team, or a single player outside any party,
// so a party is never split by a counterbalance swap. A unit is eligible only when no member is excluded, and is
// ranked by the member who sorts last under each preference. Units are taken greedily in rank order, skipping any
// that would overshoot even teams.

import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as MH from '@/models/match-history.models'
import { t, type TString } from '@/models/messages.models'
import * as PG from '@/models/player-groupings.models'
import * as SDoc from '@/models/schema-docs.models'
import * as SM from '@/models/squad.models'

export const GroupRefSchema = z.object({
	grouping: z
		.string()
		.trim()
		.min(1)
		.meta(SDoc.of({ label: t('Grouping Mode') })),
	group: z
		.string()
		.trim()
		.min(1)
		.meta(SDoc.of({ label: t('Group') })),
})
export type GroupRef = z.infer<typeof GroupRefSchema>

export const STAT_PREFERENCES = ['kd', 'kills', 'wounds'] as const
export type StatPreference = (typeof STAT_PREFERENCES)[number]

export const STAT_ORDERS = ['lowest', 'highest'] as const
export type StatOrder = (typeof STAT_ORDERS)[number]

export const PreferenceSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('group').meta(SDoc.of({ label: t('Type') })),
			grouping: GroupRefSchema.shape.grouping,
			group: GroupRefSchema.shape.group,
		}),
		z.object({
			type: z.enum(STAT_PREFERENCES).meta(SDoc.of({ label: t('Type') })),
			order: z
				.enum(STAT_ORDERS)
				.meta(SDoc.of({ label: t('Order'), options: { lowest: t('Lowest first'), highest: t('Highest first') } })),
		}),
	])
	.meta(SDoc.of({ options: { group: t('In group'), kd: t('K/D'), kills: t('Kills'), wounds: t('Wounds') } }))
export type Preference = z.infer<typeof PreferenceSchema>

const nullableLimit = (label: TString, description: TString, schema: z.ZodNumber) =>
	schema.min(0).nullable().prefault(null).meta(SDoc.of({ label, description }))

export const SettingsSchema = z.object({
	enabled: z
		.boolean()
		.prefault(false)
		.meta(
			SDoc.of({
				label: t('Enabled'),
				description: t(
					'When an admin queues or removes a swap from the web dashboard, SLM queues swaps from the other team until the team sizes are as even as possible.',
				),
			}),
		),
	rosterChangeDelay: ZodUtils.HumanTime.prefault('2m').meta(
		SDoc.of({
			label: t('Roster Change Delay'),
			description: t(
				'How long players joining, leaving or switching teams must leave the saved swaps more than one player from even before SLM re-picks the counterbalance swaps. A re-pick only happens while an admin swap is saved and nobody is editing the swaps.',
			),
		}),
	),
	neverPickGroups: z
		.array(GroupRefSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Never Picked Groups'),
				description: t('Players in these groups are never picked. A party is skipped when any member is in one.'),
			}),
		),
	neverPickAbove: z
		.object({
			kills: nullableLimit(t('Kills'), t('Players with more kills this match are never picked.'), z.number().int()),
			wounds: nullableLimit(t('Wounds'), t('Players with more wounds this match are never picked.'), z.number().int()),
			kd: nullableLimit(t('K/D'), t('Players with a higher K/D this match are never picked.'), z.number()),
		})
		.prefault({})
		.meta(SDoc.of({ label: t('Never Picked Above'), description: t('Leave a limit empty to not limit on it.') })),
	pickFirst: z
		.array(PreferenceSchema)
		.prefault([{ type: 'kd', order: 'lowest' }])
		.meta(
			SDoc.of({
				label: t('Picked First'),
				description: t(
					'Checked top to bottom. A lower line only breaks ties left by the lines above it. A party is ranked by its member who sorts last.',
				),
			}),
		),
})
export type Settings = z.infer<typeof SettingsSchema>

// where SettingsSchema sits in the server settings
export const ENABLED_SETTING_PATH = ['teamswapCounterbalance', 'enabled'] as const

export type PlayerStats = { kills: number; wounds: number; deaths: number }

export type Candidate = {
	playerId: SM.PlayerId
	team: MH.NormedTeamId
	partyId: string | null
	stats: PlayerStats
	facts: PG.PlayerFacts
}

export type Input = {
	settings: Settings
	groupings: PG.PlayerGroupings
	// everyone on a team right now
	players: Candidate[]
	// the admin-queued swaps, which counterbalance offsets and never touches
	manualSwaps: Map<SM.PlayerId, MH.NormedTeamId>
	// players an admin removed a counterbalance swap from since the last save
	skipped: ReadonlySet<SM.PlayerId>
	// players mid-execution, who cannot be queued
	pending: ReadonlySet<SM.PlayerId>
}

export type Result = {
	// player -> the team they are counterbalanced to
	swaps: Map<SM.PlayerId, MH.NormedTeamId>
	// how many more players would have had to move to reach even teams
	shortfall: number
}

// The roster as counterbalance sees it: everyone on a team, with this match's stats and their grouping facts
export function candidates(
	players: Iterable<SM.Player>,
	stats: Record<SM.PlayerId, PlayerStats>,
	ordinal: number,
	factsOf: (playerId: SM.PlayerId, player: SM.Player) => PG.PlayerFacts,
): Candidate[] {
	const result: Candidate[] = []
	for (const player of players) {
		if (player.teamId === null) continue
		const playerId = SM.PlayerIds.getPlayerId(player.ids)
		result.push({
			playerId,
			team: MH.getNormedTeamId(player.teamId, ordinal),
			partyId: player.partyId ?? null,
			stats: stats[playerId] ?? NO_STATS,
			facts: factsOf(playerId, player),
		})
	}
	return result
}

const NO_STATS: PlayerStats = { kills: 0, wounds: 0, deaths: 0 }

export function kd(stats: PlayerStats): number {
	return stats.kills / Math.max(stats.deaths, 1)
}

function statValue(stats: PlayerStats, stat: StatPreference): number {
	switch (stat) {
		case 'kd':
			return kd(stats)
		case 'kills':
			return stats.kills
		case 'wounds':
			return stats.wounds
		default:
			return assertNever(stat)
	}
}

function inGroup(groupings: PG.PlayerGroupings, ref: GroupRef, facts: PG.PlayerFacts): boolean {
	return PG.groupOf(groupings, ref.grouping, facts) === ref.group
}

function isExcluded(input: Input, player: Candidate): boolean {
	const { neverPickGroups, neverPickAbove } = input.settings
	if (neverPickAbove.kills !== null && player.stats.kills > neverPickAbove.kills) return true
	if (neverPickAbove.wounds !== null && player.stats.wounds > neverPickAbove.wounds) return true
	if (neverPickAbove.kd !== null && kd(player.stats) > neverPickAbove.kd) return true
	return neverPickGroups.some((ref) => inGroup(input.groupings, ref, player.facts))
}

// Lower sorts first. Each key is the unit's worst member under that preference, so a party is never ranked above
// what its weakest fit earns.
function rankKey(input: Input, members: Candidate[]): number[] {
	return input.settings.pickFirst.map((pref) => {
		if (pref.type === 'group') return members.every((m) => inGroup(input.groupings, pref, m.facts)) ? 0 : 1
		const values = members.map((m) => statValue(m.stats, pref.type))
		return pref.order === 'lowest' ? Math.max(...values) : -Math.min(...values)
	})
}

function compareKeys(a: number[], b: number[]): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] - b[i]
	}
	return 0
}

export function compute(input: Input): Result {
	const swaps: Map<SM.PlayerId, MH.NormedTeamId> = new Map()
	if (input.manualSwaps.size === 0) return { swaps, shortfall: 0 }

	const counts: Record<MH.NormedTeamId, number> = { A: 0, B: 0 }
	for (const player of input.players) {
		counts[input.manualSwaps.get(player.playerId) ?? player.team]++
	}
	const diff = counts.A - counts.B
	const target = Math.floor(Math.abs(diff) / 2)
	if (target === 0) return { swaps, shortfall: 0 }
	const fromTeam: MH.NormedTeamId = diff > 0 ? 'A' : 'B'
	const toTeam: MH.NormedTeamId = diff > 0 ? 'B' : 'A'

	// a unit containing anyone counterbalance may not move is dropped whole, which is what keeps parties together
	const units: Map<string, Candidate[]> = new Map()
	const blocked: Set<string> = new Set()
	for (const player of input.players) {
		const manual = input.manualSwaps.has(player.playerId)
		if (!manual && player.team !== fromTeam) continue
		const key = player.partyId !== null ? `party:${player.partyId}` : `player:${player.playerId}`
		if (manual || input.pending.has(player.playerId) || input.skipped.has(player.playerId)) {
			blocked.add(key)
			continue
		}
		if (isExcluded(input, player)) blocked.add(key)
		let unit = units.get(key)
		if (!unit) {
			unit = []
			units.set(key, unit)
		}
		unit.push(player)
	}

	const ranked = [...units.entries()]
		.filter(([key]) => !blocked.has(key))
		.map(([key, members]) => ({ key, members, rank: rankKey(input, members) }))
		.sort((a, b) => compareKeys(a.rank, b.rank) || a.members.length - b.members.length || a.key.localeCompare(b.key))

	let moved = 0
	for (const unit of ranked) {
		if (moved + unit.members.length > target) continue
		for (const member of unit.members) swaps.set(member.playerId, toTeam)
		moved += unit.members.length
		if (moved === target) break
	}
	return { swaps, shortfall: target - moved }
}
