import * as Msgs from '@/messages/shared'
import type * as PG from '@/models/player-groupings.models'

// How a grouping rule sources its match, named the way the two systems are named in the settings page rather
// than by the discriminant.
export const groupRuleSourceLabels: Record<PG.GroupRuleSource, string> = {
	battlemetrics: 'BM flag',
	'admin-list': 'Admin group',
}

// -------- the groupings editor --------

export const noGroupings = Msgs.def(() => ({
	text: () =>
		'No groupings defined. A grouping is one way of sorting players into groups; the players panel and activity charts pick ' +
		'between them by name.',
}))

export const newGroupingName = Msgs.def(() => ({ text: () => 'New grouping name' }))

export const addGrouping = Msgs.def(() => ({ text: () => 'Add grouping' }))

export const removeGrouping = Msgs.def((groupingId: string) => ({ text: () => `Remove grouping ${groupingId}` }))

// -------- one grouping's rules --------

export const rules = Msgs.def(() => ({ text: () => 'Rules' }))

export const rulesBlurb = Msgs.def(() => ({
	text: () => 'A player joins the group of the first rule whose flag they carry. Drag to reorder; priority is top to bottom.',
}))

export const noRules = Msgs.def(() => ({ text: () => 'No rules yet.' }))

export const flagColumn = Msgs.def(() => ({ text: () => 'Flag' }))

export const mappedGroupingColumn = Msgs.def(() => ({ text: () => 'Mapped grouping' }))

export const addRule = Msgs.def(() => ({ text: () => 'Add rule' }))

export const dragToReorder = Msgs.def(() => ({ text: () => 'Drag to reorder' }))

export const ruleSource = Msgs.def(() => ({ text: () => 'Rule source' }))

export const removeRule = Msgs.def(() => ({ text: () => 'Remove rule' }))

// the admin-list group a rule matches on, as opposed to the SLM group it maps into
export const adminGroupPicker = Msgs.def(() => ({ text: () => 'Admin group' }))

export const groupPicker = Msgs.def(() => ({ text: () => 'Group' }))

export const groupNamePlaceholder = Msgs.def(() => ({ text: () => 'Group name' }))

export const pickExistingGroup = Msgs.def(() => ({ text: () => 'Pick an existing group instead' }))

export const addNewGroup = Msgs.def(() => ({ text: () => 'Add new group...' }))

// -------- group colors --------

export const colorsSummary = Msgs.def((count: number) => ({ text: () => `Colors (${count})` }))

export const colorsBlurb = Msgs.def(() => ({ text: () => 'Following a flag keeps the color in step with battlemetrics.' }))

export const colorFromFlag = Msgs.def(() => ({ text: () => 'Color from flag' }))

// between the flag-derived color and the custom one, which are alternatives
export const orCustomColor = Msgs.def(() => ({ text: () => 'or' }))

export const hexColorPlaceholder = Msgs.def(() => ({ text: () => '#rrggbb' }))
