import * as Arr from '@/lib/array-utils'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'
import { def, join, t, type TString } from '@/models/messages.models'
import type * as SM from '@/models/squad.models'

// A bare "admin" badge reads as "admins can use this" rather than "only admin chat accepts this", which is what it means.
export const chatGroupLabels: Record<CMD.ChatGroup, TString> = {
	admin: t('admin only'),
	public: t('public'),
}

// Takes the chat groups rather than the channels they map to, so admin-only can be named as such: it's the
// common case by far, and it matches how they're labelled on the commands page (chatGroupLabels), where the
// raw ChatAdmin/ChatTeam enum names never appear.
export const wrongChat = def((allowedChats: CMD.ChatGroup[]) => {
	if (allowedChats.length === 1 && allowedChats[0] === 'admin') {
		return t('Admin only commands must be used in admin chat')
	}
	const correctChats = allowedChats.flatMap((s) => CMD.CHAT_GROUP_CHANNELS[s])
	return t('Command not available in this chat. Try using {correctChats}', { correctChats: correctChats.join(' or ') })
})

// What sets a way of running a command apart from the one listed above it: the fuller command text it stands for
// where there is one, and otherwise the arguments it fills in for the caller.
function groupDifference(id: CMD.CommandId, group: CMDH.TriggerGroup): TString {
	if (group.expansion !== undefined) return aliasDescription(group.expansion)
	return group.pins.length > 0 ? pinnedArgs(group.pins) : descriptions[id]
}

// `section` is the raw token typed after the help command; omitted means the quick reference. The brackets and the
// colon are the listing's own layout rather than prose, so they sit in the pattern where a translator can see what
// they punctuate.
export const help = def((commands: CMD.CommandConfigs, section?: string, plugins: CMDH.PluginCommandListing[] = []) => {
	const listing = CMDH.resolveHelpListing(commands, section, plugins)
	if (listing.code === 'err:unknown-section') return { warn: [listing.msg] }

	// one line per way of running the command: triggers that take the same thing from the caller share a line, and one
	// that takes something different gets its own
	const lines = listing.commands.flatMap((id) =>
		CMDH.triggerGroups(id, commands[id]).map((group, i) =>
			t('[{triggers}]{signature}: {description}', {
				triggers: group.strings.toSorted((a, b) => a.length - b.length).join(', '),
				signature: group.signature ? ` ${group.signature}` : '',
				// the first line is the command; the rest only have to say how they differ from it
				description: i === 0 ? descriptions[id] : groupDifference(id, group),
			}),
		),
	)
	// a plugin's command has no declared arguments, so it lists as its triggers, its usage line and its own blurb
	lines.push(
		...listing.pluginCommands.map(({ decl, config }) =>
			t('[{triggers}]{signature}: {description}', {
				triggers: config.triggers
					.map(CMD.triggerString)
					.toSorted((a, b) => a.length - b.length)
					.join(', '),
				signature: decl.usage ? ` ${decl.usage}` : '',
				description: decl.description,
			}),
		),
	)
	if (lines.length === 0) {
		return { warn: [t('{title}: none.', { title: listing.title }), ...(listing.hint ? [listing.hint] : [])] }
	}
	const groups = Arr.paged(lines, 3)
	groups[0].unshift(t('{title}:', { title: listing.title }))
	// the hint tells you how to see the rest, so it trails the listing rather than crowding the first warn
	if (listing.hint) groups[groups.length - 1].push(listing.hint)
	// one warn per group, since chat can only take a few lines at a time
	return { warn: groups.map((group) => join(group)) }
})

// What a caller sees when an argument didn't resolve but something close enough did, and they are asked to pick.
// These carry the whole explanation: the exchange is meant to be understood from the chat it happens in.
export namespace Prompt {
	// The resolver's own account of the failure heads the list: only it knows whether the word failed as a team or
	// as a squad. Option numbers are plain digits rather than formatted numbers, since the caller types them back.
	export const question = def((opts: { msg: string; choices: CMD.ArgChoice[]; step: number; total: number }) => {
		const head =
			opts.total > 1 ? t('({step}/{total}) {msg}', { step: opts.step, total: opts.total, msg: opts.msg }) : t('{msg}', { msg: opts.msg })
		const options = opts.choices.map((choice, i) => t('{index}) {label}', { index: i + 1, label: choice.label }))
		return { warn: join([head, ...options, t('Reply 1-{last}, or 0 to cancel', { last: opts.choices.length })]) }
	})

	export const outOfRange = def((count: number) => ({ warn: t('Pick 1-{count}, or 0 to cancel', { count }) }))

	export const cancelled = def('Cancelled')

	// Naming the command matters more here than anywhere else in the exchange: the caller has moved on to something
	// else, and a bare "discarded" would leave them guessing which one lapsed.
	export const superseded = def('Discarded the pending choice for "{command}"', (command: string) => ({ command }))

	export const expired = def('The choice for "{command}" expired', (command: string) => ({ command }))
}

export namespace PingAdmins {
	export const confirmed = def('Admins have been notified, please wait for us to get back to you.')

	export const ping = def((player: SM.Player, message: string) =>
		t('AdminPing from [T:{teamId} {playerName}]: {message}', {
			teamId: player.teamId,
			playerName: player.ids.username,
			message,
		}),
	)
}

// Keyed reference data rather than a message: no target axis applies to a lookup table, but each entry is still
// prose a reader sees, in the help listing and on the commands page.
export const descriptions = {
	help: t('Display help information'),
	startVote: t('Start the configured vote'),
	abortVote: t('Abort the current vote'),
	endVoteEarly: t('End the current vote early'),
	showNext: t('Show the next item in the queue'),
	enableSlmUpdates: t('Allow SLM to set the next layer'),
	disableSlmUpdates: t('Prevent SLM from setting the next layer'),
	getSlmUpdatesEnabled: t('Check if SLM is allowed to set the next layer'),
	requestFeedback: t('Request feedback on a layer'),
	flag: t("Flag a player's BM profile, optionally with a reason (some flags require one)"),
	removeFlag: t("Remove a flag from a player's BM profile"),
	listFlags: t('List BM flags for a player, or all org flags if no player is given'),
	swapNow: t('Swap a player to the other team immediately, or to a team you name'),
	swapNext: t('Queue a player to swap teams on the next map'),
	swapSquadNow: t('Swap an entire squad to the other team immediately, or to a team you name'),
	swapSquadNext: t('Queue an entire squad to swap teams on the next map'),
	swaps: t('Show a summary of queued team swaps'),
	clearSwaps: t('Clear all queued teamswaps'),
	requestSwitch: t('Ask to switch teams: you swap immediately when the balance allows it, and queue up otherwise'),
	cancelSwitch: t('Cancel your pending switch request'),
	pingAdmins: t('Request support from the admins'),
	warn: t('Warn a player'),
	listWarnReasons: t('List the configured admin action reasons and their keywords'),
	warnSquad: t('Warn every member of a squad'),
	kill: t('Kill a player'),
	killSquad: t('Kill every member of a squad'),
	removeFromSquad: t('Remove a player from their squad'),
	disbandSquad: t('Disband a squad'),
	demoteCommander: t('Demote a player from commander'),
	broadcast: t('Send an admin broadcast: one word picks a preset, more words broadcast the message verbatim'),
	kick: t('Kick a player from the server; they may rejoin immediately'),
	kickSquad: t('Kick every member of a squad from the server'),
	timeout: t('Kick a player with a timeout (e.g. 2h); they are re-kicked on any SLM server until it expires'),
	timeoutSquad: t('Kick every member of a squad with a timeout (e.g. 2h)'),
	clearTimeout: t("Cancel a player's active timeout (works for offline players)"),
	linkSteamAccount: t('Link the Steam account you are playing on to your SLM account, using a code from the website'),
	requestLayer: t('Request a layer: autogeneration satisfies queued requests when it picks the next layer'),
	listLayerRequests: t('List the queued layer requests'),
	removeLayerRequest: t('Remove a layer request (your newest, or by number from the list)'),
} satisfies Record<CMD.CommandId, TString>

// configurable fixed-duration timeout aliases; shared by the in-game help and the web help dialog
export const aliasDescription = (command: string) => t('Shortcut for "{command}"', { command })

// What a trigger fills in for the caller, where the argument names are not otherwise on show. Used for a trigger with
// pinned arguments that has no plainer trigger to stand for, where its pins are all that distinguishes it.
export const pinnedArgs = (pins: { name: string; value: string }[]) =>
	t('always {pins}', { pins: pins.map((pin) => `${pin.name} ${pin.value}`).join(', ') })

// An argument every trigger fills in, shown against the argument itself, so only the value needs naming. The trigger
// strings come along only where they disagree on it -- with one value there is nothing to tell apart.
export const fixedArg = (fixed: { value: string; triggers: string[] }[]) =>
	t('fixed at {values}', {
		values: fixed.map((f) => (fixed.length > 1 ? `${f.value} (${f.triggers.join(', ')})` : f.value)).join(', '),
	})

export const copyFailed = def({
	toast: [t('Failed to copy'), { description: t('Could not copy command to clipboard') }],
})

// -------- the prefixes editor --------

export const prefixesBlurb = def(
	'Editing a prefix updates every command string and alias that uses it. The default prefix seeds new commands.',
)

// prefixes have no identity of their own, so every affordance addresses one by its position in the list
export const prefixLabel = def('Prefix {position}', (position: number) => ({ position }))

export const makePrefixDefault = def('Make prefix {position} the default', (position: number) => ({ position }))

export const removePrefix = def('Remove prefix {position}', (position: number) => ({ position }))

export const defaultPrefix = def('Default')

export const prefixUses = def('{count, plural, one {# use} other {# uses}}', (count: number) => ({ count }))

export const replyToUnknown = def('Reply to unknown')

export const replyToUnknownHint = def(
	'Warn an admin who types an unrecognised command with this prefix. Turn it off for a prefix another bot also answers on.',
)

// why the remove button is disabled, in the two ways it can be
export const defaultPrefixNotRemovable = def('The default prefix cannot be removed')

export const prefixStillUsed = def('{count} strings still use this prefix', (count: number) => ({ count }))

export const duplicatePrefix = def('That prefix already exists')

export const newPrefix = def('New prefix')

export const addPrefix = def('Add prefix')

// -------- one command's card --------

export const triggers = def('Triggers')

export const triggersHelp = def(
	'Strings that run this command, each starting with one of the allowed prefixes. Pin arguments to one to make it a shortcut.',
)

export const allowedChats = def('Allowed chats')

export const allowedChatsHelp = def('The in-game chats this command may be typed in.')

export const enabled = def('Enabled')

export const quickReference = def('Quick Reference')

export const quickReferenceHelp = def(
	"Show this command on the commands page's quick reference, and in the in-game help command's default listing.",
	() => ({}),
)

// -------- one command's triggers --------

export const triggerStringPlaceholder = def('prefix + command')

export const pinArgs = def('Pin args')

export const pinArgsHint = def("Pin some of this command's arguments, so the trigger becomes a shortcut")

export const pinnedArgsPlaceholder = def("'{{arg1}}' 2h '{{rest2}}'")

export const unpinArgs = def('Unpin')

export const unpinArgsHint = def("Take this command's arguments as typed instead")

export const removeTrigger = def('Remove trigger {position}', (position: number) => ({ position }))

export const addTrigger = def('Add')

export const takesNoArguments = def('This command takes no arguments, so pinned args can only be fixed text.')

// introduces the list of {{ref}} arg pairs that follows
export const takesArguments = def('Takes')

// The placeholders are the syntax being explained, so they are part of the prose rather than examples the caller
// substitutes in. ICU reads a brace as an argument, so each placeholder is quoted.
export const argTemplateHelp = def(
	"A template over the words typed after the trigger, and the numbers count those words: '{{arg1}}' is the first one typed, '{{rest2}}' the second onwards. Pinned text is never typed, so no placeholder refers to it. '{{^arg2}}'default'{{/arg2}}' fills a word in when it is left out.",
)

// -------- the commands page --------

export const pageHeading = def('Ingame Commands')

export const pageBlurb = def(
	'Everything you type is case-insensitive. Player, squad and flag names match on any part of the name, ignoring spaces.',
)

export const pinnedSection = def('Your Pinned Commands')

export const quickReferenceSection = def('Quick Reference')

export const searchCommands = def('Search commands…')

export const noMatches = def('No matches.')

export const optionalArg = def('optional')

// introduces the preset values an argument accepts
export const configuredPresets = def('Configured:')

export const examplesHeading = def('Examples')

export const shortcutsHeading = def('Shortcuts')

export const linkToCommand = def('Link to this command')

export const linkToSection = def('Link to {section}', (section: string) => ({ section }))

// the cross-links between a command's listing on the commands page and its configuration in the global settings
export const settingsCrossLink = def('settings')
export const settingsCrossLinkTitle = def('Configure this command in the global settings')
export const commandsCrossLink = def('details')
export const commandsCrossLinkTitle = def('Show this command on the commands page')

export const disabledBadge = def('Disabled')

export const detailsToggle = def('Details')

export const unpinCommand = def('Unpin')

export const copyCommand = def('Copy {command}', (command: string) => ({ command }))

// -------- what a command answers with in chat --------
// One reply per outcome, addressed to whoever typed the command. `error` also becomes the result's `msg`, which is
// why these read as sentences rather than codes.

export const rconError = def('RCON error')

export const playerNotFound = def('Player not found')

export const commandDisabled = def('Command "{cmd}" is disabled', (cmd: string) => ({ cmd }))

export const pluginCommandFailed = def('The {plugin} plugin could not run that command', (plugin: string) => ({ plugin }))

export const pluginOwner = def('Provided by')
export const pluginSettingsKey = def('Settings key')
export const pluginsSectionLabel = def('Plugins')

// Named rather than counted: which string was taken, and by what, is the whole of what an admin has to act on.
export const pluginTriggerConflicts = def((conflicts: CMD.CommandConflict[]) =>
	t('{list}. Set a different trigger under pluginCommands in global settings.', {
		list: conflicts.map((c) => `"${c.trigger}" is already used by ${c.ownedBy}`).join('; '),
	}),
)

export const itemNotFound = def('Item not found')

export const playerNotOnTeam = def('Player "{username}" is not on a team', (username?: string) => ({ username }))

export const playerNotInSquad = def('Player "{username}" is not in a squad', (username?: string) => ({ username }))

export const squadHasNoPlayers = def('Squad "{squadName}" has no players', (squadName: string) => ({ squadName }))

// -------- teamswaps --------

export const swapInProgress = def('A team swap is currently in progress')

export const swappingNow = def('Swapping {username} to {toTeam} now', (username: string | undefined, toTeam: TString) => ({
	username,
	toTeam,
}))

export const alreadyMarkedForSwap = def('{username} is already marked to swap teams', (username?: string) => ({ username }))

export const queuedSwapNext = def('Queued {username} to swap to {toTeam} on next map', (username: string | undefined, toTeam: TString) => ({
	username,
	toTeam,
}))

export const swappingSquadNow = def(
	'Swapping {count, plural, one {# player} other {# players}} from "{squadName}" to {toTeam} now',
	(count: number, squadName: string, toTeam: TString) => ({ count, squadName, toTeam }),
)

export const squadAlreadyMarkedForSwap = def('All players in "{squadName}" are already marked to swap teams', (squadName: string) => ({
	squadName,
}))

export const queuedSquadSwapNext = def(
	'Queued {count, plural, one {# player} other {# players}} from "{squadName}" to swap to {toTeam} on next map',
	(count: number, squadName: string, toTeam: TString) => ({ count, squadName, toTeam }),
)

// what a swap command with an explicit destination answers when there is nothing left to do

export const alreadyOnTeam = def('{username} is already on {toTeam}', (username: string | undefined, toTeam: TString) => ({
	username,
	toTeam,
}))

export const alreadyQueuedForTeam = def(
	'{username} is already queued to swap to {toTeam} on next map',
	(username: string | undefined, toTeam: TString) => ({ username, toTeam }),
)

export const squadAlreadyOnTeam = def('All players in "{squadName}" are already on {toTeam}', (squadName: string, toTeam: TString) => ({
	squadName,
	toTeam,
}))

export const squadAlreadyQueuedForTeam = def(
	'All players in "{squadName}" are already queued to swap to {toTeam} on next map',
	(squadName: string, toTeam: TString) => ({ squadName, toTeam }),
)

export const noSwapsQueued = def('No swaps queued')

export const noTeamswapsQueued = def('No teamswaps queued')

export const clearSwapsFailed = def('Failed to clear queued teamswaps')

export const swapsCleared = def('Cleared all queued teamswaps')

// -------- player flags --------

export const battlemetricsDisabled = def('Player flags are unavailable: this instance has no battlemetrics integration configured')

export const noFlagMatch = def('No flag matches found for "{flag}"', (flag: string) => ({ flag }))

export const multipleFlagMatches = def('Multiple({count}) flag matches found for "{flag}".', (count: number, flag: string) => ({
	count,
	flag,
}))

export const playerNotInBattlemetrics = def('Unable to resolve player "{username}" in battlemetrics', (username?: string) => ({ username }))

export const playerLacksFlag = def('Player "{username}" does not have flag "{flag}".', (username: string | undefined, flag: string) => ({
	username,
	flag,
}))

export const flagAlreadyRemoved = def(
	'Flag "{flag}" is already removed from {username}\'s BM profile',
	(flag: string, username?: string) => ({ flag, username }),
)

// -------- moderation --------
// A reason is optional on every one of these, and the clause that names it belongs to the sentence rather than to
// the caller, so each pattern carries both readings.

export const noReasonsConfigured = def('No admin action reasons are configured')

export const warned = def('Warned {username}: "{message}"', (username: string | undefined, message: string) => ({ username, message }))

export const warnedSquad = def('Warned {squadLabel}: "{message}"', (squadLabel: string, message: string) => ({ squadLabel, message }))

export const removedFromSquad = def(
	'Removed {username} from their squad{hasReason, select, yes { for {reason}} other {}}',
	(username: string | undefined, reason?: string) => ({ username, reason, hasReason: reason ? 'yes' : 'no' }),
)

export const disbandedSquad = def(
	'Disbanded "{squadName}" on team {teamLabel}{hasReason, select, yes { for {reason}} other {}}',
	(squadName: string, teamLabel: string, reason?: string) => ({ squadName, teamLabel, reason, hasReason: reason ? 'yes' : 'no' }),
)

export const demoted = def(
	'Demoted {username}{hasReason, select, yes { for {reason}} other {}}',
	(username: string | undefined, reason?: string) => ({ username, reason, hasReason: reason ? 'yes' : 'no' }),
)

export const kicked = def('Kicked {subject}{hasReason, select, yes { for {reason}} other {}}', (subject: string, reason?: string) => ({
	subject,
	reason,
	hasReason: reason ? 'yes' : 'no',
}))

// -------- timeouts --------

export const noTimeoutMatch = def('No active timeout matches "{token}"', (token: string) => ({ token }))

export const multipleTimeoutMatches = def('{count} timed-out players match "{token}"', (count: number, token: string) => ({ count, token }))

export const timeoutsCancelled = def(
	'Cancelled {count, plural, one {the timeout} other {# timeouts}} for {username}',
	(count: number, username: string) => ({ count, username }),
)

// -------- layer requests --------

export const noLayerRequestNumber = def('No layer request #{number}', (number: number) => ({ number }))

export const noLayerRequests = def('You have no layer requests queued')
