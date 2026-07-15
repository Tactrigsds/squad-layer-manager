// Presentation-level grouping of the settings forms' top-level keys, shared by the form renderer and the TOC.
// Grouping lives here rather than in the schemas so the persisted settings shape is untouched; keys not listed in
// any group render ungrouped after the groups (so newly added settings surface automatically).

export type SettingsGroup = { slug: string; label: string; keys: string[] }

export const GLOBAL_SETTINGS_GROUPS: SettingsGroup[] = [
	{ slug: 'general', label: 'General', keys: ['topBarColor', 'navLinks', 'warnOnSlmStart'] },
	{
		slug: 'messaging',
		label: 'Messaging & Reasons',
		keys: ['warnPrefix', 'adminActionReasons', 'requireReasonFor', 'broadcasts', 'messageVariables', 'chat'],
	},
	{ slug: 'commands', label: 'In-game Commands', keys: ['allowedPrefixes', 'defaultPrefix', 'commands', 'timeoutCommandAliases'] },
	{ slug: 'queue-and-votes', label: 'Queue & Votes', keys: ['layerQueue', 'vote', 'layerTable', 'layerGeneration'] },
	{
		slug: 'squad-server',
		label: 'Squad Server',
		keys: ['squadServer', 'fogOffDelay', 'postRollAnnouncementsTimeout', 'balanceTriggerLevels'],
	},
	{ slug: 'players', label: 'Players & Flags', keys: ['playerFlagGroupings', 'playerFlagsRequiringNote'] },
	// rbac stays ungrouped: its own section header already reads "Permissions & Roles"
]

// server settings aren't grouped, but the fields an operator must configure to get a new server working (connection
// details, admin list sources, admin-identifying permissions) float to the top of the form; the rest follow in schema
// order. Presentation-only, so the persisted shape is untouched (same rationale as the groups above).
export const SERVER_SETTINGS_PRIORITY_KEYS: string[] = ['connections', 'adminListSources', 'adminIdentifyingPermissions']

// paths the TOC must treat as leaves even though their schema node is an object with properties: they render via
// override widgets, so no per-property anchors exist in the DOM
export const TOC_LEAF_PATHS: ReadonlySet<string> = new Set([
	'layerTable',
	'layerGeneration',
	'queue.mainPool',
	'queue.generationPool',
	// the whole playerFlagGroupings subtree renders as one bespoke editor (modes + groupings), so it emits no per-subkey anchors
	'playerFlagGroupings',
	// the whole rbac subtree renders as one consolidated per-role editor, so it emits no per-subkey anchors
	'rbac',
])

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
