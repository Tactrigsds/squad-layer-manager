import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import type * as BM from '@/models/battlemetrics.models'
import { t } from '@/models/messages.models'
import * as SDoc from '@/models/schema-docs.models'
import * as SM from '@/models/squad.models'

// Compiled once per distinct pattern rather than per player per render: a rule is evaluated against every player on
// the roster, and the pattern only changes when settings do. Patterns that don't compile cache as null and never match,
// so a bad one costs nothing beyond the first attempt.
const compiledPatterns = new Map<string, RegExp | null>()

export function compilePattern(pattern: string): RegExp | null {
	if (compiledPatterns.has(pattern)) return compiledPatterns.get(pattern)!
	let compiled: RegExp | null
	try {
		compiled = new RegExp(pattern, 'i')
	} catch {
		compiled = null
	}
	compiledPatterns.set(pattern, compiled)
	return compiled
}

// Rejected at the edit rather than silently never matching, so a typo surfaces in the settings form.
const PatternSchema = z
	.string()
	.trim()
	.min(1)
	.refine((p) => compilePattern(p) !== null, { message: 'not a valid regular expression' })

// A rule assigns players matching one source-specific attribute to a group. Sources are independent: rules from
// different ones sit in the same priority order and a grouping may mix them freely.
export const GroupRuleSchema = z
	.discriminatedUnion('type', [
		// a flag on the player's battlemetrics profile
		z.object({
			type: z.literal('battlemetrics').meta(SDoc.of({ label: t('Type') })),
			flag: z.string().meta(SDoc.of({ label: t('Flag') })),
			group: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Group') })),
		}),
		// membership of a group in the server's admin list (`Group=<adminGroup>:<perms>`). Not every admin-list group makes
		// its members admins -- a reserve-slot group like Whitelist is exactly the sort of thing worth grouping on.
		z.object({
			type: z.literal('admin-list').meta(SDoc.of({ label: t('Type') })),
			adminGroup: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Admin Group') })),
			group: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Group') })),
		}),
		// holds an admin-identifying permission on the server, whichever admin-list group granted it. The union of every
		// `admin-list` rule an operator could write is not the same thing: this stays correct as the admin list gains groups.
		z.object({
			type: z.literal('server-admin').meta(SDoc.of({ label: t('Type') })),
			group: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Group') })),
		}),
		// the player's in-game name matches, case-insensitively. Substring by default, since the use is clan tags.
		z.object({
			type: z.literal('name-regex').meta(SDoc.of({ label: t('Type') })),
			pattern: PatternSchema.meta(SDoc.of({ label: t('Pattern') })),
			group: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Group') })),
		}),
		// the player's clan tag matches, case-insensitively. Players whose tag we don't know match no such rule.
		z.object({
			type: z.literal('tag-regex').meta(SDoc.of({ label: t('Type') })),
			pattern: PatternSchema.meta(SDoc.of({ label: t('Pattern') })),
			group: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Group') })),
		}),
		// a role on the discord account the player has linked their steam account to. Players who have linked nothing
		// match no such rule, which is the same outcome as holding none of the role.
		z.object({
			type: z.literal('discord-role').meta(SDoc.of({ label: t('Type') })),
			roleId: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Role ID') })),
			group: z
				.string()
				.trim()
				.min(1)
				.meta(SDoc.of({ label: t('Group') })),
		}),
	])
	.meta(
		SDoc.of({
			options: {
				battlemetrics: t('BM flag'),
				'admin-list': t('Admin group'),
				'server-admin': t('Server admin'),
				'name-regex': t('Name matches'),
				'tag-regex': t('Tag matches'),
				'discord-role': t('Discord role'),
			},
		}),
	)
export type GroupRule = z.infer<typeof GroupRuleSchema>
export type GroupRuleSource = GroupRule['type']

export const GROUP_RULE_SOURCES: GroupRuleSource[] = [
	'battlemetrics',
	'admin-list',
	'server-admin',
	'name-regex',
	'tag-regex',
	'discord-role',
]

// What a rule matches against. Sourced per player and per server: the admin list is the server's own, so the same
// grouping can put a player in different groups on different servers, which is the point of it being server config.
export type PlayerFacts = {
	flags: BM.PlayerFlag[]
	adminGroups: string[]
	isAdmin: boolean
	username: string
	tag: string | undefined
	// role ids on the linked discord account; empty when the player has linked none
	discordRoles: string[]
	partyId: string | null
}

// The roster fields a rule can match on. Structural rather than SM.Player so a RecentPlayer satisfies it too: a
// player who has disconnected still has a name, an admin list and a linked discord account.
export type PlayerFactsSource = {
	ids: { username: string; usernameNoTag?: string }
	isAdmin: boolean
	adminGroups?: string[]
	discordRoles?: string[]
	partyId?: string | null
}

// Facts come from two places and neither knows about the other: the server stamps what it resolved for the roster
// entry, and battlemetrics data arrives on the client over its own stream. This is where the two meet.
export function playerFacts(player: PlayerFactsSource, flags: BM.PlayerFlag[]): PlayerFacts {
	return {
		flags,
		adminGroups: player.adminGroups ?? [],
		isAdmin: player.isAdmin,
		username: player.ids.username,
		tag: SM.PlayerIds.getTag(player.ids),
		discordRoles: player.discordRoles ?? [],
		partyId: player.partyId ?? null,
	}
}

// A group's color either follows one of its own flags -- so a recolour in battlemetrics reaches the UI without anyone
// editing settings -- or is pinned to a literal. The `flag` variant stores only the reference, never a copy of the color.
export const GroupColorSchema = z
	.discriminatedUnion('type', [
		z.object({ type: z.literal('flag').meta(SDoc.of({ label: t('Type') })), flag: z.string().meta(SDoc.of({ label: t('Flag') })) }),
		z.object({ type: z.literal('custom').meta(SDoc.of({ label: t('Type') })), color: z.string().meta(SDoc.of({ label: t('Color') })) }),
	])
	.meta(SDoc.of({ options: { flag: t('Flag color'), custom: t('Custom color') } }))
export type GroupColor = z.infer<typeof GroupColorSchema>

// Presentation for a group. Group membership comes from the rules, so nothing here can affect who lands where.
export const GroupSchema = z.object({
	color: GroupColorSchema.meta(SDoc.of({ label: t('Color') })),
})
export type Group = z.infer<typeof GroupSchema>

// One named way of bucketing players: an ordered rule list plus presentation for the groups those rules name.
// Rule order is priority order, highest first -- a player takes the group of the first rule they match.
export const GroupingSchema = z.object({
	rules: z
		.array(GroupRuleSchema)
		.prefault([])
		.meta(SDoc.of({ label: t('Rules') })),
	groups: z
		.record(z.string(), GroupSchema)
		.prefault({})
		.meta(SDoc.of({ label: t('Groups') })),
})
export type Grouping = z.infer<typeof GroupingSchema>

export const GroupingIdSchema = z.string().trim().min(1)

export const PlayerGroupingsSchema = z.record(GroupingIdSchema, GroupingSchema)
export type PlayerGroupings = z.infer<typeof PlayerGroupingsSchema>

export const EMPTY_PLAYER_GROUPINGS: PlayerGroupings = {}

export const EMPTY_GROUPING: Grouping = { rules: [], groups: {} }

export const DEFAULT_GROUP_COLOR = '#888888'

// The grouping a fresh install starts with, and the one a dev instance is given: it buckets a server's roster by
// the admin list, which is the one source every install has without configuring anything. Its groups are the ones
// the emulated servers seed their admin lists with, so a sandbox breaks down into something on first sight.
export const SEEDED_GROUPING_ID = 'Admin List'

// Rule order is priority order, so the groups are read in the order they are given. Colors are literal: an admin
// list carries none to follow.
export function adminListGrouping(groups: readonly { name: string; label: string; color: string }[]): Grouping {
	return {
		rules: groups.map((group): GroupRule => ({ type: 'admin-list', adminGroup: group.name, group: group.label })),
		groups: Object.fromEntries(groups.map((group) => [group.label, { color: { type: 'custom' as const, color: group.color } }])),
	}
}

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
			return orgFlags?.find((f) => f.id === color.flag)?.color ?? DEFAULT_GROUP_COLOR
		case 'custom':
			return color.color
		default:
			return assertNever(color)
	}
}

export function getGroupColor(grouping: Grouping, group: string, orgFlags: BM.PlayerFlag[] | undefined): string {
	return resolveGroupColor(grouping.groups[group]?.color, orgFlags)
}

// the color a group takes when nothing is configured for it: the first of its own flags that has one
export function defaultGroupColor(grouping: Grouping, group: string, orgFlags: BM.PlayerFlag[] | undefined): GroupColor | undefined {
	for (const flag of getGroupFlags(grouping, group)) {
		if (orgFlags?.find((f) => f.id === flag)?.color) return { type: 'flag', flag }
	}
	return undefined
}

function matchesRule(rule: GroupRule, facts: PlayerFacts): boolean {
	switch (rule.type) {
		case 'battlemetrics':
			return facts.flags.some((f) => f.id === rule.flag)
		case 'admin-list':
			return facts.adminGroups.includes(rule.adminGroup)
		case 'server-admin':
			return facts.isAdmin
		case 'name-regex':
			return compilePattern(rule.pattern)?.test(facts.username) ?? false
		case 'tag-regex':
			return facts.tag !== undefined && (compilePattern(rule.pattern)?.test(facts.tag) ?? false)
		case 'discord-role':
			return facts.discordRoles.includes(rule.roleId)
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
	for (const [playerId, facts] of players) {
		const group = groupOf(groupings, groupingId, facts)
		if (group !== undefined) groups.set(playerId, group)
	}
	return groups
}

// ---- the party grouping ----
//
// Buckets players by the in-game party they queued with. It is built in rather than configured: its groups are whatever
// party ids the roster holds right now, which no rule list can name ahead of time. The functions below take any
// grouping id, configured or this one, so a caller never branches on which kind is active.

// Reserved: a configured grouping by this name is shadowed by the built-in one.
export const PARTY_GROUPING_ID = '__party__'

// the grouping modes on offer: every configured grouping, then the party grouping
export function groupingIdsWithParty(groupings: PlayerGroupings): string[] {
	return [...getGroupingIds(groupings).filter((id) => id !== PARTY_GROUPING_ID), PARTY_GROUPING_ID]
}

export function groupOf(groupings: PlayerGroupings, groupingId: string, facts: PlayerFacts): string | undefined {
	if (groupingId === PARTY_GROUPING_ID) return facts.partyId ?? undefined
	const grouping = groupings[groupingId]
	return grouping ? resolveGroup(grouping, facts) : undefined
}

// The groups to lay out, in order. A configured grouping lists every group its rules can assign; the party grouping
// lists the parties among `assigned`, the groups the roster at hand was resolved to.
export function groupNamesOf(groupings: PlayerGroupings, groupingId: string, assigned: Iterable<string>): string[] {
	if (groupingId === PARTY_GROUPING_ID) return [...new Set(assigned)].sort(comparePartyIds)
	const grouping = groupings[groupingId]
	return grouping ? getGroupNames(grouping) : []
}

export function groupColorOf(groupings: PlayerGroupings, groupingId: string, group: string, orgFlags: BM.PlayerFlag[] | undefined): string {
	if (groupingId === PARTY_GROUPING_ID) return partyColor(group)
	const grouping = groupings[groupingId]
	return grouping ? getGroupColor(grouping, group, orgFlags) : DEFAULT_GROUP_COLOR
}

// Party ids read "#0", "#12": by number where both have one, so #2 sorts before #10, and as text otherwise.
export function comparePartyIds(a: string, b: string): number {
	const numA = /^#(\d+)$/.exec(a)
	const numB = /^#(\d+)$/.exec(b)
	if (numA && numB) return Number(numA[1]) - Number(numB[1])
	return a.localeCompare(b)
}

const PARTY_COLORS = ['#4e9bf5', '#e8a33d', '#4cc38a', '#e5649b', '#a07ef0', '#43c6c9', '#d9d24a', '#f07a54', '#8fb35a', '#c48a6a']

// Keyed on the party number, so a party keeps its color as other parties form and break up around it.
function partyColor(partyId: string): string {
	const num = /^#(\d+)$/.exec(partyId)
	let index = num ? Number(num[1]) : 0
	if (!num) for (const ch of partyId) index = (index * 31 + ch.charCodeAt(0)) >>> 0
	return PARTY_COLORS[index % PARTY_COLORS.length]
}
