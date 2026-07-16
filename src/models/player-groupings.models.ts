import { assertNever } from '@/lib/type-guards'
import type * as BM from '@/models/battlemetrics.models'
import type * as SM from '@/models/squad.models'
import { z } from 'zod'

// A rule assigns players matching one source-specific attribute to a group. Battlemetrics flags are the only
// source today; the discriminator is what lets another source be added without reshaping a grouping.
export const GroupRuleSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('battlemetrics'),
		flag: z.string(),
		group: z.string().trim().min(1),
	}),
])
export type GroupRule = z.infer<typeof GroupRuleSchema>

// Presentation for a group. Group membership comes from the rules, so nothing here can affect who lands where.
export const GroupSchema = z.object({
	color: z.string(),
})
export type Group = z.infer<typeof GroupSchema>

// One named way of bucketing players: an ordered rule list plus presentation for the groups those rules name.
// Rule order is priority order, highest first -- a player takes the group of the first rule they match.
export const GroupingSchema = z.object({
	rules: z.array(GroupRuleSchema).prefault([]),
	groups: z.record(z.string(), GroupSchema).prefault({}),
})
export type Grouping = z.infer<typeof GroupingSchema>

export const GroupingIdSchema = z.string().trim().min(1)

export const PlayerGroupingsSchema = z.record(GroupingIdSchema, GroupingSchema)
export type PlayerGroupings = z.infer<typeof PlayerGroupingsSchema>

export const EMPTY_PLAYER_GROUPINGS: PlayerGroupings = {}

export const EMPTY_GROUPING: Grouping = { rules: [], groups: {} }

// shown for players no rule matched
export const UNGROUPED_LABEL = 'Other'

export const DEFAULT_GROUP_COLOR = '#888888'

export function getGroupingIds(groupings: PlayerGroupings): string[] {
	return Object.keys(groupings)
}

// The groups a grouping can assign, in priority order. Derived from the rules rather than the `groups` map so the
// two can never disagree about which groups exist; `groups` only decides how they look.
export function getGroupNames(grouping: Grouping): string[] {
	const names: string[] = []
	for (const rule of grouping.rules) {
		if (!names.includes(rule.group)) names.push(rule.group)
	}
	return names
}

export function getGroupColor(grouping: Grouping, group: string): string {
	return grouping.groups[group]?.color ?? DEFAULT_GROUP_COLOR
}

function matchesRule(rule: GroupRule, flags: BM.PlayerFlag[]): boolean {
	switch (rule.type) {
		case 'battlemetrics':
			return flags.some(f => f.id === rule.flag)
		default:
			return assertNever(rule.type)
	}
}

// the group a player belongs to under `grouping`, or undefined when no rule matches
export function resolveGroup(grouping: Grouping, flags: BM.PlayerFlag[]): string | undefined {
	for (const rule of grouping.rules) {
		if (matchesRule(rule, flags)) return rule.group
	}
	return undefined
}

export function resolvePlayerGroups(
	players: [SM.PlayerId, BM.PlayerFlag[]][],
	groupings: PlayerGroupings,
	groupingId: string | null | undefined,
): Map<SM.PlayerId, string> {
	const groups: Map<SM.PlayerId, string> = new Map()
	if (!groupingId) return groups
	const grouping = groupings[groupingId]
	if (!grouping) return groups

	for (const [playerId, flags] of players) {
		const group = resolveGroup(grouping, flags)
		if (group !== undefined) groups.set(playerId, group)
	}
	return groups
}
