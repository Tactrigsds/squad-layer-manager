// Presentation-level grouping of the in-game commands, used by the commands help dialog's table of contents.
// Grouping lives here rather than in the command declarations so the persisted command config shape is untouched;
// commands not listed in any group render in a trailing "Other" group (so newly added commands surface automatically).

import type * as CMD from '@/models/command.models'

export type CommandGroup = { slug: string; label: string; ids: CMD.CommandId[] }

export const COMMAND_GROUPS: CommandGroup[] = [
	{ slug: 'general', label: 'General', ids: ['help', 'showNext', 'requestFeedback'] },
	{
		slug: 'votes',
		label: 'Votes & SLM Updates',
		ids: ['startVote', 'abortVote', 'endVoteEarly', 'enableSlmUpdates', 'disableSlmUpdates', 'getSlmUpdatesEnabled'],
	},
	{
		slug: 'teamswitches',
		label: 'Teamswitches',
		ids: ['switchNow', 'switchNext', 'switchSquadNow', 'switchSquadNext', 'swaps', 'clearSwitches'],
	},
	{ slug: 'flags', label: 'Player Flags', ids: ['flag', 'removeFlag', 'listFlags'] },
	{
		slug: 'moderation',
		label: 'Moderation',
		ids: [
			'warn',
			'warnSquad',
			'kill',
			'killSquad',
			'removeFromSquad',
			'disbandSquad',
			'demoteCommander',
			'kick',
			'kickSquad',
			'timeout',
			'timeoutSquad',
			'clearTimeout',
			'listWarnReasons',
		],
	},
	{ slug: 'messaging', label: 'Messaging', ids: ['broadcast'] },
]

const OTHER_GROUP: CommandGroup = { slug: 'other', label: 'Other', ids: [] }

// partition `ids` into the ordered group buckets, appending any ungrouped commands as a trailing "Other" group
export function splitCommandsByGroup(ids: CMD.CommandId[]): { group: CommandGroup; ids: CMD.CommandId[] }[] {
	const grouped = new Set(COMMAND_GROUPS.flatMap((g) => g.ids))
	const buckets = COMMAND_GROUPS
		.map((group) => ({ group, ids: group.ids.filter((id) => ids.includes(id)) }))
		.filter((b) => b.ids.length > 0)
	const ungrouped = ids.filter((id) => !grouped.has(id))
	if (ungrouped.length > 0) buckets.push({ group: OTHER_GROUP, ids: ungrouped })
	return buckets
}
