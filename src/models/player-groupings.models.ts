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

// A group's color either follows one of its own flags -- so a recolour in battlemetrics reaches the UI without anyone
// editing settings -- or is pinned to a literal. The `flag` variant stores only the reference, never a copy of the color.
export const GroupColorSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('flag'), flag: z.string() }),
	z.object({ type: z.literal('custom'), color: z.string() }),
])
export type GroupColor = z.infer<typeof GroupColorSchema>

// Presentation for a group. Group membership comes from the rules, so nothing here can affect who lands where.
export const GroupSchema = z.object({
	color: GroupColorSchema,
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

// The flags a group's color may follow: those of the rules that put players in it. A group's look should come from
// something that actually defines it, so flags belonging to other groups are not offered.
export function getGroupFlags(grouping: Grouping, group: string): string[] {
	const flags: string[] = []
	for (const rule of grouping.rules) {
		if (rule.group === group && rule.flag && !flags.includes(rule.flag)) flags.push(rule.flag)
	}
	return flags
}

// The one place the flag-color reference is followed. Falls back when the flag is gone from the org or carries no
// color of its own, so a stale reference degrades to the default rather than breaking the render.
export function resolveGroupColor(color: GroupColor | undefined, orgFlags: BM.PlayerFlag[] | undefined): string {
	if (!color) return DEFAULT_GROUP_COLOR
	switch (color.type) {
		case 'flag':
			return orgFlags?.find(f => f.id === color.flag)?.color ?? DEFAULT_GROUP_COLOR
		case 'custom':
			return color.color
		default:
			return assertNever(color)
	}
}

export function getGroupColor(grouping: Grouping, group: string, orgFlags: BM.PlayerFlag[] | undefined): string {
	return resolveGroupColor(grouping.groups[group]?.color, orgFlags)
}

// Moves the rule at `from` to sit before/after the rule currently at `to`, which is how a drag-to-reorder drop reads.
// The target is resolved by identity before the move, so pulling the dragged rule out of the list can't shift the
// insertion point out from under us. A no-op drop (onto itself) returns the same rules.
export function moveRule(rules: GroupRule[], from: number, to: number, position: 'before' | 'after'): GroupRule[] {
	const moved = rules[from]
	const target = rules[to]
	if (!moved || !target) return rules
	const without = rules.filter((_, i) => i !== from)
	let insertAt = without.indexOf(target)
	if (insertAt < 0) return rules
	if (position === 'after') insertAt += 1
	return [...without.slice(0, insertAt), moved, ...without.slice(insertAt)]
}

// the color a group takes when nothing is configured for it: the first of its own flags that has one
export function defaultGroupColor(grouping: Grouping, group: string, orgFlags: BM.PlayerFlag[] | undefined): GroupColor | undefined {
	for (const flag of getGroupFlags(grouping, group)) {
		if (orgFlags?.find(f => f.id === flag)?.color) return { type: 'flag', flag }
	}
	return undefined
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
