import * as Arr from '@/lib/array-utils'
import * as Msgs from '@/messages/shared'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'

// A bare "admin" badge reads as "admins can use this" rather than "only admin chat accepts this", which is what it means.
export const chatGroupLabels: Record<CMD.ChatGroup, string> = {
	admin: 'admin only',
	public: 'public',
}

// Takes the chat groups rather than the channels they map to, so admin-only can be named as such: it's the
// common case by far, and it matches how they're labelled on the commands page (chatGroupLabels), where the
// raw ChatAdmin/ChatTeam enum names never appear.
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

// -------- the prefixes editor --------

export const prefixesBlurb = Msgs.def(() => ({
	text: () => 'Editing a prefix updates every command string and alias that uses it. The default prefix seeds new commands.',
}))

// prefixes have no identity of their own, so every affordance addresses one by its position in the list
export const prefixLabel = Msgs.def((position: number) => ({ text: () => `Prefix ${position}` }))

export const makePrefixDefault = Msgs.def((position: number) => ({ text: () => `Make prefix ${position} the default` }))

export const removePrefix = Msgs.def((position: number) => ({ text: () => `Remove prefix ${position}` }))

export const defaultPrefix = Msgs.def(() => ({ text: () => 'Default' }))

export const prefixUses = Msgs.def((count: number) => ({ text: () => `${count} ${count === 1 ? 'use' : 'uses'}` }))

// why the remove button is disabled, in the two ways it can be
export const defaultPrefixNotRemovable = Msgs.def(() => ({ text: () => 'The default prefix cannot be removed' }))

export const prefixStillUsed = Msgs.def((count: number) => ({ text: () => `${count} strings still use this prefix` }))

export const duplicatePrefix = Msgs.def(() => ({ text: () => 'That prefix already exists' }))

export const newPrefix = Msgs.def(() => ({ text: () => 'New prefix' }))

export const addPrefix = Msgs.def(() => ({ text: () => 'Add prefix' }))

// -------- one command's card --------

export const triggers = Msgs.def(() => ({ text: () => 'Triggers' }))

export const triggersHelp = Msgs.def(() => ({
	text: () => 'Strings that run this command, each starting with one of the allowed prefixes. Pin arguments to one to make it a shortcut.',
}))

export const allowedChats = Msgs.def(() => ({ text: () => 'Allowed chats' }))

export const allowedChatsHelp = Msgs.def(() => ({ text: () => 'The in-game chats this command may be typed in.' }))

export const enabled = Msgs.def(() => ({ text: () => 'Enabled' }))

export const quickReference = Msgs.def(() => ({ text: () => 'Quick Reference' }))

export const quickReferenceHelp = Msgs.def(() => ({
	text: () => `Show this command on the commands page's quick reference, and in the in-game help command's default listing.`,
}))

// -------- one command's triggers --------

export const triggerStringPlaceholder = Msgs.def(() => ({ text: () => 'prefix + command' }))

export const pinArgs = Msgs.def(() => ({ text: () => 'Pin args' }))

export const pinArgsHint = Msgs.def(() => ({ text: () => `Pin some of this command's arguments, so the trigger becomes a shortcut` }))

export const pinnedArgsPlaceholder = Msgs.def(() => ({ text: () => '{{arg1}} 2h {{rest2}}' }))

export const unpinArgs = Msgs.def(() => ({ text: () => 'Unpin' }))

export const unpinArgsHint = Msgs.def(() => ({ text: () => `Take this command's arguments as typed instead` }))

export const removeTrigger = Msgs.def((position: number) => ({ text: () => `Remove trigger ${position}` }))

export const addTrigger = Msgs.def(() => ({ text: () => 'Add' }))

export const takesNoArguments = Msgs.def(() => ({ text: () => 'This command takes no arguments, so pinned args can only be fixed text.' }))

// introduces the list of {{ref}} arg pairs that follows
export const takesArguments = Msgs.def(() => ({ text: () => 'Takes' }))

// The placeholders are the syntax being explained, so they are part of the prose rather than examples the caller
// substitutes in.
export const argTemplateHelp = Msgs.def(() => ({
	text: () =>
		'A template over the words typed after the trigger, and the numbers count those words: {{arg1}} is the first one typed, ' +
		'{{rest2}} the second onwards. Pinned text is never typed, so no placeholder refers to it. ' +
		'{{^arg2}}default{{/arg2}} fills a word in when it is left out.',
}))

// -------- the commands page --------

export const pageHeading = Msgs.def(() => ({ text: () => 'Ingame Commands' }))

export const pageBlurb = Msgs.def(() => ({
	text: () => 'Everything you type is case-insensitive. Player, squad and flag names match on any part of the name, ignoring spaces.',
}))

export const pinnedSection = Msgs.def(() => ({ text: () => 'Your Pinned Commands' }))

export const quickReferenceSection = Msgs.def(() => ({ text: () => 'Quick Reference' }))

export const searchCommands = Msgs.def(() => ({ text: () => 'Search commands…' }))

export const noMatches = Msgs.def(() => ({ text: () => 'No matches.' }))

export const optionalArg = Msgs.def(() => ({ text: () => 'optional' }))

// introduces the preset values an argument accepts
export const configuredPresets = Msgs.def(() => ({ text: () => 'Configured:' }))

export const examplesHeading = Msgs.def(() => ({ text: () => 'Examples' }))

export const shortcutsHeading = Msgs.def(() => ({ text: () => 'Shortcuts' }))

export const linkToCommand = Msgs.def(() => ({ text: () => 'Link to this command' }))

export const linkToSection = Msgs.def((section: string) => ({ text: () => `Link to ${section}` }))

export const disabledBadge = Msgs.def(() => ({ text: () => 'Disabled' }))

export const detailsToggle = Msgs.def(() => ({ text: () => 'Details' }))

export const unpinCommand = Msgs.def(() => ({ text: () => 'Unpin' }))

export const copyCommand = Msgs.def((command: string) => ({ text: () => `Copy ${command}` }))
