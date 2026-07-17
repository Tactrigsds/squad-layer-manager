// Presentation-level grouping of the settings forms' top-level keys, shared by the form renderer and the TOC.
// Grouping lives here rather than in the schemas so the persisted settings shape is untouched; keys not listed in
// any group render ungrouped after the groups (so newly added settings surface automatically).

export type SettingsGroup = { slug: string; label: string; keys: string[] }

// top-level global-settings keys that render no field of their own in the GUI (they're managed inline by a sibling
// editor), so neither the form nor the TOC should emit a row/anchor for them. `defaultPrefix` is chosen via the
// "default" markers in the allowedPrefixes editor.
export const HIDDEN_GLOBAL_SETTINGS_KEYS: ReadonlySet<string> = new Set(['defaultPrefix'])

export const GLOBAL_SETTINGS_GROUPS: SettingsGroup[] = [
	{ slug: 'general', label: 'General', keys: ['topBarColor', 'navLinks', 'warnOnSlmStart'] },
	{
		slug: 'messaging',
		label: 'Messaging & Reasons',
		keys: ['warnPrefix', 'adminActionReasons', 'requireReasonFor', 'broadcasts', 'messageVariables', 'chat'],
	},
	{ slug: 'commands', label: 'In-game Commands', keys: ['allowedPrefixes', 'defaultPrefix', 'commands', 'commandAliases'] },
	{ slug: 'queue-and-votes', label: 'Queue & Votes', keys: ['layerQueue', 'vote', 'layerTable', 'layerGeneration'] },
	{
		slug: 'squad-server',
		label: 'Squad Server',
		keys: ['squadServer', 'fogOffDelay', 'postRollAnnouncementsTimeout', 'balanceTriggerLevels'],
	},
	{ slug: 'players', label: 'Players & Flags', keys: ['playerGroupings', 'playerFlagsRequiringNote'] },
	// rbac stays ungrouped: its own section header already reads "Permissions & Roles"
]

// server settings aren't grouped, but the fields an operator must configure to get a new server working (connection
// details, admin list sources, admin-identifying permissions) float to the top of the form; the rest follow in schema
// order. Presentation-only, so the persisted shape is untouched (same rationale as the groups above).
export const SERVER_SETTINGS_PRIORITY_KEYS: string[] = ['connections', 'adminListSources', 'adminIdentifyingPermissions']

// Settings most installs never touch. Their field renders inside an "Advanced" disclosure at the bottom of whichever
// section owns it (a group, a nested section, or the form root), collapsed by default. Matched on the field's dotted
// path, so a whole subtree can be tucked away by naming its root. Presentation-only, like the groups above: the field
// itself is unchanged, and the TOC still lists it (navigating to one opens the disclosure it sits in).
export const ADVANCED_GLOBAL_SETTINGS_PATHS: ReadonlySet<string> = new Set([
	'topBarColor',
	'warnOnSlmStart',
	'warnPrefix',
	'chat',
	'allowedPrefixes',
	'layerQueue.lowQueueWarningThreshold',
	'layerQueue.adminQueueReminderInterval',
	'vote.voteReminderInterval',
	'vote.internalVoteReminderInterval',
	'vote.finalVoteReminder',
	'vote.autoStartVoteCutoff',
	'vote.maxNumVoteChoices',
	'squadServer',
	'fogOffDelay',
	'postRollAnnouncementsTimeout',
])

export const ADVANCED_SERVER_SETTINGS_PATHS: ReadonlySet<string> = new Set([
	'updatesToSquadServerDisabled',
	'overrideAdminSetNextLayer',
	'warnOnChangeLayer',
	'navLinks',
])

// Subtrees whose GUI editor is elaborate enough that bulk edits (reordering, copying a role between installs, pasting a
// block from a diff) are easier as text. Their field header gets a GUI/JSON toggle that swaps just that subtree for a
// schema-checked JSON editor, so the rest of the form stays as it is. Matched on the field's dotted path; only paths
// whose schema is statically addressable (see Zod.schemaAtPath) can be listed, and nothing holding a secret should be.
export const LOCAL_JSON_EDITOR_PATHS: ReadonlySet<string> = new Set([
	// global
	'rbac',
	'commands',
	'adminActionReasons',
	'broadcasts',
	'commandAliases',
	'messageVariables',
	'playerGroupings',
	'layerTable',
	'layerGeneration',
	'balanceTriggerLevels',
	'chat',
	// server
	'queue',
	'adminListSources',
])

// paths the TOC must treat as leaves even though their schema node is an object with properties: they render via
// override widgets, so no per-property anchors exist in the DOM
export const TOC_LEAF_PATHS: ReadonlySet<string> = new Set([
	'layerTable',
	'layerGeneration',
	'queue.mainPool',
	'queue.generationPool',
	// the whole playerGroupings subtree renders as one bespoke editor, so it emits no per-subkey anchors
	'playerGroupings',
	// the whole rbac subtree renders as one consolidated per-role editor, so it emits no per-subkey anchors
	'rbac',
])

// partition a section's child keys into the ones it renders directly and the ones that belong in its "Advanced"
// disclosure, preserving the incoming order within each. `parentPath` is the dotted path of the section itself ('' at
// the form root), since advanced-ness is declared per full path.
export function splitAdvanced(keys: string[], parentPath: string, advanced: ReadonlySet<string>): { normal: string[]; advanced: string[] } {
	const isAdvanced = (key: string) => advanced.has(parentPath ? `${parentPath}.${key}` : key)
	return { normal: keys.filter((k) => !isAdvanced(k)), advanced: keys.filter(isAdvanced) }
}

// partition `keys` (schema property order) into the ordered group buckets plus the ungrouped remainder
export function splitByGroups(
	keys: string[],
	groups: SettingsGroup[],
): { groups: { group: SettingsGroup; keys: string[] }[]; ungrouped: string[] } {
	const grouped = new Set(groups.flatMap((g) => g.keys))
	return {
		groups: groups
			.map((group) => ({ group, keys: group.keys.filter((k) => keys.includes(k)) }))
			.filter((g) => g.keys.length > 0),
		ungrouped: keys.filter((k) => !grouped.has(k)),
	}
}
