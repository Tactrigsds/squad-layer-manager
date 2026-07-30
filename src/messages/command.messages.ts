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
	warn: (locale?: string) => {
		if (allowedChats.length === 1 && allowedChats[0] === 'admin') {
			return Msgs.t('Admin only commands must be used in admin chat', undefined, locale)
		}
		const correctChats = allowedChats.flatMap((s) => CMD.CHAT_GROUP_CHANNELS[s])
		return Msgs.t('Command not available in this chat. Try using {correctChats}', { correctChats: correctChats.join(' or ') }, locale)
	},
}))

// `section` is the raw token typed after the help command; omitted means the quick reference.
// Still assembles its text in JavaScript, so it takes no locale yet and renders in English. `pnpm script
// src/scripts/extract-messages.ts` counts what is left.
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

// What a caller sees when an argument didn't resolve but something close enough did, and they are asked to pick.
// These carry the whole explanation: the exchange is meant to be understood from the chat it happens in.
export namespace Prompt {
	// The resolver's own account of the failure heads the list: only it knows whether the word failed as a team or
	// as a squad. Option numbers are plain digits rather than formatted numbers, since the caller types them back.
	export const question = Msgs.def((opts: { msg: string; choices: CMD.ArgChoice[]; step: number; total: number }) => ({
		warn: (locale?: string) => {
			const head =
				opts.total > 1
					? Msgs.t('({step}/{total}) {msg}', { step: String(opts.step), total: String(opts.total), msg: opts.msg }, locale)
					: opts.msg
			const options = opts.choices.map((choice, i) => `${i + 1}) ${choice.label}`)
			return [head, ...options, Msgs.t('Reply 1-{last}, or 0 to cancel', { last: String(opts.choices.length) }, locale)].join('\n')
		},
	}))

	export const outOfRange = Msgs.def((count: number) => ({
		warn: (locale?: string) => Msgs.t('Pick 1-{count}, or 0 to cancel', { count: String(count) }, locale),
	}))

	export const cancelled = Msgs.def(() => ({
		warn: (locale?: string) => Msgs.t('Cancelled', undefined, locale),
	}))

	// Naming the command matters more here than anywhere else in the exchange: the caller has moved on to something
	// else, and a bare "discarded" would leave them guessing which one lapsed.
	export const superseded = Msgs.def((command: string) => ({
		warn: (locale?: string) => Msgs.t('Discarded the pending choice for "{command}"', { command }, locale),
	}))

	export const expired = Msgs.def((command: string) => ({
		warn: (locale?: string) => Msgs.t('The choice for "{command}" expired', { command }, locale),
	}))
}

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
	toast: () => [Msgs.t('Failed to copy'), { description: Msgs.t('Could not copy command to clipboard') }],
}))

// -------- the prefixes editor --------

export const prefixesBlurb = Msgs.def(
	'Editing a prefix updates every command string and alias that uses it. The default prefix seeds new commands.',
)

// prefixes have no identity of their own, so every affordance addresses one by its position in the list
export const prefixLabel = Msgs.def('Prefix {position}', (position: number) => ({ position }))

export const makePrefixDefault = Msgs.def('Make prefix {position} the default', (position: number) => ({ position }))

export const removePrefix = Msgs.def('Remove prefix {position}', (position: number) => ({ position }))

export const defaultPrefix = Msgs.def('Default')

export const prefixUses = Msgs.def('{count, plural, one {# use} other {# uses}}', (count: number) => ({ count }))

// why the remove button is disabled, in the two ways it can be
export const defaultPrefixNotRemovable = Msgs.def('The default prefix cannot be removed')

export const prefixStillUsed = Msgs.def('{count} strings still use this prefix', (count: number) => ({ count }))

export const duplicatePrefix = Msgs.def('That prefix already exists')

export const newPrefix = Msgs.def('New prefix')

export const addPrefix = Msgs.def('Add prefix')

// -------- one command's card --------

export const triggers = Msgs.def('Triggers')

export const triggersHelp = Msgs.def(
	'Strings that run this command, each starting with one of the allowed prefixes. Pin arguments to one to make it a shortcut.',
)

export const allowedChats = Msgs.def('Allowed chats')

export const allowedChatsHelp = Msgs.def('The in-game chats this command may be typed in.')

export const enabled = Msgs.def('Enabled')

export const quickReference = Msgs.def('Quick Reference')

export const quickReferenceHelp = Msgs.def(
	"Show this command on the commands page's quick reference, and in the in-game help command's default listing.",
	() => ({}),
)

// -------- one command's triggers --------

export const triggerStringPlaceholder = Msgs.def('prefix + command')

export const pinArgs = Msgs.def('Pin args')

export const pinArgsHint = Msgs.def("Pin some of this command's arguments, so the trigger becomes a shortcut")

export const pinnedArgsPlaceholder = Msgs.def('{{arg1}} 2h {{rest2}}')

export const unpinArgs = Msgs.def('Unpin')

export const unpinArgsHint = Msgs.def("Take this command's arguments as typed instead")

export const removeTrigger = Msgs.def('Remove trigger {position}', (position: number) => ({ position }))

export const addTrigger = Msgs.def('Add')

export const takesNoArguments = Msgs.def('This command takes no arguments, so pinned args can only be fixed text.')

// introduces the list of {{ref}} arg pairs that follows
export const takesArguments = Msgs.def('Takes')

// The placeholders are the syntax being explained, so they are part of the prose rather than examples the caller
// substitutes in.
export const argTemplateHelp = Msgs.def(
	() =>
		'A template over the words typed after the trigger, and the numbers count those words: {{arg1}} is the first one typed, ' +
		'{{rest2}} the second onwards. Pinned text is never typed, so no placeholder refers to it. ' +
		'{{^arg2}}default{{/arg2}} fills a word in when it is left out.',
)

// -------- the commands page --------

export const pageHeading = Msgs.def('Ingame Commands')

export const pageBlurb = Msgs.def(
	'Everything you type is case-insensitive. Player, squad and flag names match on any part of the name, ignoring spaces.',
)

export const pinnedSection = Msgs.def('Your Pinned Commands')

export const quickReferenceSection = Msgs.def('Quick Reference')

export const searchCommands = Msgs.def('Search commands…')

export const noMatches = Msgs.def('No matches.')

export const optionalArg = Msgs.def('optional')

// introduces the preset values an argument accepts
export const configuredPresets = Msgs.def('Configured:')

export const examplesHeading = Msgs.def('Examples')

export const shortcutsHeading = Msgs.def('Shortcuts')

export const linkToCommand = Msgs.def('Link to this command')

export const linkToSection = Msgs.def('Link to {section}', (section: string) => ({ section }))

export const disabledBadge = Msgs.def('Disabled')

export const detailsToggle = Msgs.def('Details')

export const unpinCommand = Msgs.def('Unpin')

export const copyCommand = Msgs.def('Copy {command}', (command: string) => ({ command }))
