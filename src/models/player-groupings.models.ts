import { assertNever } from '@/lib/type-guards'
import type * as BM from '@/models/battlemetrics.models'
import type * as SM from '@/models/squad.models'
import { z } from 'zod'

// A rule assigns players matching one source-specific attribute to a group. Sources are independent: rules from
// different ones sit in the same priority order and a grouping may mix them freely.
export const GroupRuleSchema = z.discriminatedUnion('type', [
	// a flag on the player's battlemetrics profile
	z.object({
		type: z.literal('battlemetrics'),
		flag: z.string(),
		group: z.string().trim().min(1),
	}),
	// membership of a group in the server's admin list (`Group=<adminGroup>:<perms>`). Not every admin-list group makes
	// its members admins -- a reserve-slot group like Whitelist is exactly the sort of thing worth grouping on.
	z.object({
		type: z.literal('admin-list'),
		adminGroup: z.string().trim().min(1),
		group: z.string().trim().min(1),
	}),
])
export type GroupRule = z.infer<typeof GroupRuleSchema>
export type GroupRuleSource = GroupRule['type']

export const GROUP_RULE_SOURCES: GroupRuleSource[] = ['battlemetrics', 'admin-list']

export const GROUP_RULE_SOURCE_LABELS: Record<GroupRuleSource, string> = {
	'battlemetrics': 'BM flag',
	'admin-list': 'Admin group',
}

// What a rule matches against. Sourced per player and per server: the admin list is the server's own, so the same
// grouping can put a player in different groups on different servers, which is the point of it being server config.
export type PlayerFacts = {
	flags: BM.PlayerFlag[]
	adminGroups: string[]
}

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
// something that actually defines it, so flags belonging to other groups are not offered. A group defined only by
// admin-list rules has none, and takes a custom color instead -- an admin list carries no colors to follow.
export function getGroupFlags(grouping: Grouping, group: string): string[] {
	const flags: string[] = []
	for (const rule of grouping.rules) {
		if (rule.type !== 'battlemetrics') continue
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

function matchesRule(rule: GroupRule, facts: PlayerFacts): boolean {
	switch (rule.type) {
		case 'battlemetrics':
			return facts.flags.some(f => f.id === rule.flag)
		case 'admin-list':
			return facts.adminGroups.includes(rule.adminGroup)
		default:
			return assertNever(rule)
	}
}

// the group a player belongs to under `grouping`, or undefined when no rule matches
export function resolveGroup(grouping: Grouping, facts: PlayerFacts): string | undefined {
	for (const rule of grouping.rules) {
		if (matchesRule(rule, facts)) return rule.group
	}
	return undefined
}

export function resolvePlayerGroups(
	players: [SM.PlayerId, PlayerFacts][],
	groupings: PlayerGroupings,
	groupingId: string | null | undefined,
): Map<SM.PlayerId, string> {
	const groups: Map<SM.PlayerId, string> = new Map()
	if (!groupingId) return groups
	const grouping = groupings[groupingId]
	if (!grouping) return groups

	for (const [playerId, facts] of players) {
		const group = resolveGroup(grouping, facts)
		if (group !== undefined) groups.set(playerId, group)
	}
	return groups
}
