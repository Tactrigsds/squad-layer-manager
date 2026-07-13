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
	{ slug: 'commands', label: 'In-game Commands', keys: ['commandPrefix', 'commands', 'timeoutCommandAliases'] },
	{ slug: 'queue-and-votes', label: 'Queue & Votes', keys: ['layerQueue', 'vote', 'layerTable', 'layerGeneration'] },
	{
		slug: 'squad-server',
		label: 'Squad Server',
		keys: ['squadServer', 'adminListSources', 'fogOffDelay', 'postRollAnnouncementsTimeout', 'balanceTriggerLevels'],
	},
	{ slug: 'players', label: 'Players & Flags', keys: ['playerFlagColorHierarchy', 'playerFlagsRequiringNote', 'playerFlagGroupings'] },
	// rbac stays ungrouped: its own section header already reads "Permissions & Roles"
]

// paths the TOC must treat as leaves even though their schema node is an object with properties: they render via
// override widgets, so no per-property anchors exist in the DOM
export const TOC_LEAF_PATHS: ReadonlySet<string> = new Set([
	'layerTable',
	'layerGeneration',
	'queue.mainPool',
	'queue.generationPool',
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
