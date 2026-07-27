import type * as PG from '@/models/player-groupings.models'

// How a grouping rule sources its match, named the way each system is named in the settings page rather than by
// the discriminant.
export const groupRuleSourceLabels: Record<PG.GroupRuleSource, string> = {
	battlemetrics: 'BM flag',
	'admin-list': 'Admin group',
	'server-admin': 'Server admin',
	'name-regex': 'Name matches',
	'discord-role': 'Discord role',
}

// what the rule's value field is asking for, shown as its column header once a grouping mixes sources
export const groupRuleSourceHints: Record<PG.GroupRuleSource, string> = {
	battlemetrics: "A flag on the player's battlemetrics profile.",
	'admin-list': "Membership of a group in the server's admin list. Not every group makes its members admins.",
	'server-admin': 'Holds an admin-identifying permission on the server, from any admin-list group.',
	'name-regex': 'Case-insensitive regular expression against the in-game name. Unanchored, so it matches anywhere in the name.',
	'discord-role': 'A role on the discord account the player linked their steam account to.',
}
