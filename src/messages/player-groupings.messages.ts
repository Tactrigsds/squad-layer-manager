import * as Msgs from '@/messages/shared'
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

// -------- the groupings editor --------

export const noGroupings = Msgs.def(
	() =>
		'No groupings defined. A grouping is one way of sorting players into groups; the players panel and activity charts pick ' +
		'between them by name.',
)

export const newGroupingName = Msgs.def('New grouping name')

export const addGrouping = Msgs.def('Add grouping')

export const removeGrouping = Msgs.def('Remove grouping {groupingId}', (groupingId: string) => ({ groupingId }))

// -------- one grouping's rules --------

export const rules = Msgs.def('Rules')

export const rulesBlurb = Msgs.def('A player joins the group of the first rule they match. Drag to reorder; priority is top to bottom.')

export const noRules = Msgs.def('No rules yet.')

export const matchesColumn = Msgs.def('Matches')

export const mappedGroupingColumn = Msgs.def('Mapped grouping')

export const addRule = Msgs.def('Add rule')

export const dragToReorder = Msgs.def('Drag to reorder')

export const ruleSource = Msgs.def('Rule source')

export const removeRule = Msgs.def('Remove rule')

// the admin-list group a rule matches on, as opposed to the SLM group it maps into
export const adminGroupPicker = Msgs.def('Admin group')

export const groupPicker = Msgs.def('Group')

// a server-admin rule has nothing to pick, so its value cell says what it matches instead
export const serverAdminRuleValue = Msgs.def('Any admin-list group that makes them an admin')

// the example is a clan tag, which is what a name pattern is almost always for
export const namePatternPlaceholder = Msgs.def('Name pattern, e.g. ^\\[TT\\]')

export const invalidNamePattern = Msgs.def('Not a valid regular expression')

export const groupNamePlaceholder = Msgs.def('Group name')

export const pickExistingGroup = Msgs.def('Pick an existing group instead')

export const addNewGroup = Msgs.def('Add new group...')

// -------- group colors --------

export const colorsSummary = Msgs.def('Colors ({count})', (count: number) => ({ count }))

export const colorsBlurb = Msgs.def('Following a flag keeps the color in step with battlemetrics.')

export const colorFromFlag = Msgs.def('Color from flag')

// between the flag-derived color and the custom one, which are alternatives
export const orCustomColor = Msgs.def('or')

export const hexColorPlaceholder = Msgs.def('#rrggbb')
