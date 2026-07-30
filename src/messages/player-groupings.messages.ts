import { def, t, type TString } from '@/models/messages.models'
import type * as PG from '@/models/player-groupings.models'

// How a grouping rule sources its match, named the way each system is named in the settings page rather than by
// the discriminant.
export const groupRuleSourceLabels: Record<PG.GroupRuleSource, TString> = {
	battlemetrics: t('BM flag'),
	'admin-list': t('Admin group'),
	'server-admin': t('Server admin'),
	'name-regex': t('Name matches'),
	'discord-role': t('Discord role'),
}

// what the rule's value field is asking for, shown as its column header once a grouping mixes sources
export const groupRuleSourceHints: Record<PG.GroupRuleSource, TString> = {
	battlemetrics: t("A flag on the player's battlemetrics profile."),
	'admin-list': t("Membership of a group in the server's admin list. Not every group makes its members admins."),
	'server-admin': t('Holds an admin-identifying permission on the server, from any admin-list group.'),
	'name-regex': t('Case-insensitive regular expression against the in-game name. Unanchored, so it matches anywhere in the name.'),
	'discord-role': t('A role on the discord account the player linked their steam account to.'),
}

// -------- the groupings editor --------

export const noGroupings = def(
	'No groupings defined. A grouping is one way of sorting players into groups; the players panel and activity charts pick between them by name.',
)

export const newGroupingName = def('New grouping name')

export const addGrouping = def('Add grouping')

export const removeGrouping = def('Remove grouping {groupingId}', (groupingId: string) => ({ groupingId }))

// -------- one grouping's rules --------

export const rules = def('Rules')

export const rulesBlurb = def('A player joins the group of the first rule they match. Drag to reorder; priority is top to bottom.')

export const noRules = def('No rules yet.')

export const matchesColumn = def('Matches')

export const mappedGroupingColumn = def('Mapped grouping')

export const addRule = def('Add rule')

export const dragToReorder = def('Drag to reorder')

export const ruleSource = def('Rule source')

export const removeRule = def('Remove rule')

// the admin-list group a rule matches on, as opposed to the SLM group it maps into
export const adminGroupPicker = def('Admin group')

export const groupPicker = def('Group')

// a server-admin rule has nothing to pick, so its value cell says what it matches instead
export const serverAdminRuleValue = def('Any admin-list group that makes them an admin')

// the example is a clan tag, which is what a name pattern is almost always for
export const namePatternPlaceholder = def('Name pattern, e.g. ^\\[TT\\]')

export const invalidNamePattern = def('Not a valid regular expression')

export const groupNamePlaceholder = def('Group name')

export const pickExistingGroup = def('Pick an existing group instead')

export const addNewGroup = def('Add new group...')

// -------- group colors --------

export const colorsSummary = def('Colors ({count})', (count: number) => ({ count }))

export const colorsBlurb = def('Following a flag keeps the color in step with battlemetrics.')

export const colorFromFlag = def('Color from flag')

// between the flag-derived color and the custom one, which are alternatives
export const orCustomColor = def('or')

export const hexColorPlaceholder = def('#rrggbb')
