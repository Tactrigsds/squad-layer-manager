import * as Arr from '@/lib/array-utils'
import * as Msgs from '@/messages/shared'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'

// Takes the chat groups rather than the channels they map to, so admin-only can be named as such: it's the
// common case by far, and it matches how they're labelled on the commands page (CMD.CHAT_GROUP_LABELS),
// where the raw ChatAdmin/ChatTeam enum names never appear.
export const wrongChat = Msgs.def((allowedChats: CMD.ChatGroup[]) => ({
	warn: () => {
		if (allowedChats.length === 1 && allowedChats[0] === 'admin') return 'Admin only commands must be used in admin chat'
		const correctChats = allowedChats.flatMap((s) => CMD.CHAT_GROUP_CHANNELS[s])
		return `Command not available in this chat. Try using ${correctChats.join(' or ')}`
	},
}))

// `section` is the raw token typed after the help command; omitted means the quick reference.
export const help = Msgs.def((commands: CMD.CommandConfigs, section?: string) => ({
	// one string per warn, since chat can only take a few lines at a time
	warn: () => {
		const listing = CMDH.resolveHelpListing(commands, section)
		if (listing.code === 'err:unknown-section') return [listing.msg]

		const lines = listing.commands.flatMap((id) => {
			const cmd = commands[id]
			const plain = cmd.triggers.filter((t) => CMD.triggerArgs(t) === undefined).map(CMD.triggerString)
			const sortedStrings = plain.toSorted((a, b) => a.length - b.length)
			const signature = CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS[id].args)
			const own = `[${sortedStrings.join(', ')}]${signature ? ` ${signature}` : ''}: ${descriptions[id]}`
			// a trigger that pins arguments takes a different thing from the caller, so it gets its own line
			const shortcuts = cmd.triggers
				.filter((t) => CMD.triggerArgs(t) !== undefined)
				.map((t) => `[${CMD.formatTriggerUsage(id, t)}]: ${aliasDescription(CMD.describeTriggerExpansion(cmd, t))}`)
			return [own, ...shortcuts]
		})
		if (lines.length === 0) return [`${listing.title}: none.`, ...(listing.hint ? [listing.hint] : [])]
		const groups = Arr.paged(lines, 3)
		groups[0].unshift(`${listing.title}:`)
		// the hint tells you how to see the rest, so it trails the listing rather than crowding the first warn
		if (listing.hint) groups[groups.length - 1].push(listing.hint)
		return groups.map((g) => g.join('\n'))
	},
}))

// Keyed reference data rather than a message: no target axis applies to a lookup table.
export const descriptions = {
	help: 'Display help information',
	startVote: 'Start the configured vote',
	abortVote: 'Abort the current vote',
	endVoteEarly: 'End the current vote early',
	showNext: 'Show the next item in the queue',
	enableSlmUpdates: 'Allow SLM to set the next layer',
	disableSlmUpdates: 'Prevent SLM from setting the next layer',
	getSlmUpdatesEnabled: 'Check if SLM is allowed to set the next layer',
	requestFeedback: 'Request feedback on a layer',
	flag: "Flag a player's BM profile, optionally with a reason (some flags require one)",
	removeFlag: "Remove a flag from a player's BM profile",
	listFlags: 'List BM flags for a player, or all org flags if no player is given',
	swapNow: 'Swap a player to the opposite team immediately',
	swapNext: 'Queue a player to swap teams on the next map',
	swapSquadNow: 'Swap an entire squad to the opposite team immediately',
	swapSquadNext: 'Queue an entire squad to swap teams on the next map',
	swaps: 'Show a summary of queued team swaps',
	clearSwaps: 'Clear all queued teamswaps',
	warn: 'Warn a player',
	listWarnReasons: 'List the configured admin action reasons and their keywords',
	warnSquad: 'Warn every member of a squad',
	kill: 'Kill a player',
	killSquad: 'Kill every member of a squad',
	removeFromSquad: 'Remove a player from their squad',
	disbandSquad: 'Disband a squad',
	demoteCommander: 'Demote a player from commander',
	broadcast: 'Send an admin broadcast: one word picks a preset, more words broadcast the message verbatim',
	kick: 'Kick a player from the server; they may rejoin immediately',
	kickSquad: 'Kick every member of a squad from the server',
	timeout: 'Kick a player with a timeout (e.g. 2h); they are re-kicked on any SLM server until it expires',
	timeoutSquad: 'Kick every member of a squad with a timeout (e.g. 2h)',
	clearTimeout: "Cancel a player's active timeout (works for offline players)",
	requestLayer: 'Request a layer: autogeneration satisfies queued requests when it picks the next layer',
	listLayerRequests: 'List the queued layer requests',
	removeLayerRequest: 'Remove a layer request (your newest, or by number from the list)',
} satisfies Record<CMD.CommandId, string>

// configurable fixed-duration timeout aliases; shared by the in-game help and the web help dialog
export const aliasDescription = (command: string) => `Shortcut for "${command}"`

export const copyFailed = Msgs.def(() => ({
	toast: () => ['Failed to copy', { description: 'Could not copy command to clipboard' }],
}))
