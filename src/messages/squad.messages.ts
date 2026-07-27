import * as Msgs from '@/messages/shared'
import type * as SM from '@/models/squad.models'

// a supplied reason is already the fully-rendered verbatim message; only the no-reason case gets a default
export const notifyKilled = Msgs.def((reason?: string) => ({
	warn: () => reason || 'You have been killed by an admin.',
}))

// Same shape, and it covers the plain kick and the timeout kick alike: the timeout's remaining duration is
// already substituted into the reason by the time it gets here.
export const notifyKicked = Msgs.def((reason?: string) => ({
	text: () => reason || 'You have been kicked by an admin.',
}))

export const kill = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Kill ${Msgs.targetNoun(target)}`,
		description: `Kill ${Msgs.targetSubject(
			target,
		)}? They will be force-switched teams twice in quick succession to trigger a respawn, ending back on their current team.`,
		confirmLabel: 'Kill',
	}),
	toast: () => [`Killed ${Msgs.targetAffected(target)}`],
}))

export const killFailed = Msgs.def((reason: string) => ({
	toast: () => ['Kill failed', { description: reason }],
}))

export const kick = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Kick ${Msgs.targetNoun(target)}`,
		description: `Kick ${Msgs.targetSubject(target)} from the server? They may rejoin immediately.`,
		confirmLabel: 'Kick',
	}),
	toast: () => [`Kicked ${Msgs.targetAffected(target)}`],
}))

export const kickFailed = Msgs.def((reason: string) => ({
	toast: () => ['Kick failed', { description: reason }],
}))

export const timeout = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Timeout ${Msgs.targetNoun(target)}`,
		description: `Kick ${Msgs.targetSubject(
			target,
		)}? They will be re-kicked on join from any SLM-managed server until the timeout expires.`,
		confirmLabel: 'Timeout',
	}),
}))

export const timedOut = Msgs.def((target: Msgs.Target, duration: string) => ({
	toast: () => [`Timed out ${Msgs.targetAffected(target)} for ${duration}`],
}))

export const timeoutFailed = Msgs.def((reason: string) => ({
	toast: () => ['Timeout failed', { description: reason }],
}))

// a bulk timeout fans out one call per player, so some can fail while the rest succeed
export const timeoutCancelled = Msgs.def(() => ({ toast: () => ['Timeout cancelled'] }))

export const cancelTimeoutFailed = Msgs.def((reason: string) => ({
	toast: () => ['Cancel failed', { description: reason }],
}))

export const someTimeoutsFailed = Msgs.def((count: number) => ({
	toast: () => [
		`${count} timeout${count === 1 ? '' : 's'} failed`,
		{ description: 'They may already have an active timeout or have left the server.' },
	],
}))

export const invalidTimeoutDuration = Msgs.def(() => ({
	toast: () => ['Invalid duration', { description: 'Use a duration like 30m, 2h or 1d' }],
}))

export const timeoutTooLong = Msgs.def((maxDuration: string) => ({
	toast: () => ['Duration too long', { description: `Your maximum timeout is ${maxDuration}` }],
}))

export const warnPreset = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: `Warn ${Msgs.targetNoun(target)}`,
		description: `Warn ${Msgs.targetSubject(target)} with a preset reason?`,
		confirmLabel: 'Warn',
	}),
}))

export const warned = Msgs.def((target: Msgs.Target, presetReasonLabel: string) => ({
	toast: () => [`Warned ${Msgs.targetAffected(target)} for ${presetReasonLabel}`],
}))

export const warnFailed = Msgs.def((reason: string) => ({
	toast: () => ['Warn failed', { description: reason }],
}))

// squadLabel is the quoted squad name, absent when the player's squad is not resolvable from live state
export const removeFromSquad = Msgs.def((target: Msgs.Target, squadLabel?: string) => ({
	confirm: () => ({
		title: 'Remove from Squad',
		description:
			target.kind === 'players'
				? `Remove ${target.count} players from their squads?`
				: `Remove this player from ${squadLabel ?? 'their squad'}?`,
		confirmLabel: 'Remove',
	}),
}))

// the three below are the loading/success/error legs of one toast.promise, which takes bare values rather than
// toast args, so they are `text` rather than `toast`
export const removingFromSquad = Msgs.def((count: number) => ({
	text: () => `Removing ${count} players from their squads...`,
}))

export const removedFromSquad = Msgs.def((count: number) => ({
	text: () => `Removed ${count} players from their squads`,
}))

export const removeFromSquadFailed = Msgs.def((count: number) => ({
	toast: () => ['Remove from squad failed', { description: `Failed to remove ${count} players` }],
}))

// teamId is named only from the player menu, where the squad is reached through one of its members and so is not
// otherwise identified on screen
export const disbandSquad = Msgs.def((squadLabel: string, teamId?: number) => ({
	confirm: () => ({
		title: 'Disband Squad',
		description: teamId === undefined ? `Disband squad ${squadLabel}?` : `Disband ${squadLabel} on team ${teamId}?`,
		confirmLabel: 'Disband',
	}),
}))

export const resetSquadName = Msgs.def((squadLabel: string) => ({
	confirm: () => ({
		title: 'Reset Squad Name',
		description: `Reset the name of ${squadLabel} to default?`,
		confirmLabel: 'Reset',
	}),
}))

export const demoteCommander = Msgs.def(() => ({
	confirm: () => ({
		title: 'Demote Commander',
		description: 'Demote this player from commander?',
		confirmLabel: 'Demote',
	}),
}))

export const copiedToClipboard = Msgs.def((what: string, count: number = 1) => ({
	toast: () => ['Copied', { description: count > 1 ? `${count} ${what}s copied to clipboard` : `${what} copied to clipboard` }],
}))

// actionName is the admin action's display name, so the prompt says which action is being blocked
export const reasonRequired = Msgs.def((actionName: string) => ({
	toast: () => ['Reason required', { description: `A reason is required for ${actionName}.` }],
}))

// -------- the admin lists editor --------
// A list is a name, one source and the group permissions that mark an admin *in that list*. Its name is what
// servers and role assignments refer to.

export const noAdminLists = Msgs.def(() => ({ text: () => 'No admin lists defined.' }))

export const newAdminListName = Msgs.def(() => ({ text: () => 'new list name' }))

export const addAdminList = Msgs.def(() => ({ text: () => 'Add list' }))

export const deleteAdminList = Msgs.def((name: string) => ({ text: () => `Delete ${name}` }))

export const adminListPicker = Msgs.def(() => ({ text: () => 'Admin list' }))

export const selectAdminLists = Msgs.def(() => ({ text: () => 'Select admin lists...' }))

// a list the server still names but the global settings no longer define; kept selectable so opening the editor
// cannot silently drop it
export const adminListNotConfigured = Msgs.def((listId: string) => ({ text: () => `${listId} (not configured)` }))

export const adminIdentifyingPermissions = Msgs.def(() => ({ text: () => 'Admin-identifying permissions' }))

export const adminIdentifyingPermissionsHelp = Msgs.def(() => ({
	text: () => 'Group permissions in this list that mark a player as an in-game admin on the servers using it.',
}))

export const permissionPicker = Msgs.def(() => ({ text: () => 'Permission' }))

export const selectPermissions = Msgs.def(() => ({ text: () => 'Select permissions...' }))

// how each source kind is named in the picker, and what its one string field looks like
export const adminSourceTypeLabels: Record<SM.AdminListSourceType, string> = {
	remote: 'Remote URL',
	local: 'Local file',
	ftp: 'FTP',
	sftp: 'SFTP',
}

export const adminSourcePlaceholders: Record<Exclude<SM.AdminListSourceType, 'sftp'>, string> = {
	remote: 'https://host/admins.cfg',
	local: 'path/to/Admins.cfg',
	ftp: 'ftp://user:password@host:21/admins.cfg',
}

export const sftpHost = Msgs.def(() => ({ text: () => 'host' }))

export const sftpUsername = Msgs.def(() => ({ text: () => 'username' }))

export const sftpPassword = Msgs.def(() => ({ text: () => 'password' }))

export const sftpFilePath = Msgs.def(() => ({ text: () => '/path/to/Admins.cfg' }))

// A sandbox additionally has one SLM synthesises, which is not in the list because there is no source to name --
// so say so, rather than leaving the impression that an empty selection means the emulated server has no admins.
export const sandboxAdminListTitle = Msgs.def(() => ({ text: () => 'This sandbox has an emulated admin list of its own' }))

export const sandboxAdminListBlurb = Msgs.def(() => ({
	text: () =>
		'It applies on top of anything selected here and is edited from the sandbox control window (Server Actions -> Sandbox ' +
		'Controls), where you can define groups and tick which fabricated players are admins. There is no source to configure, ' +
		'because it only exists in memory.',
}))

// -------- the player and squad context menus --------
// The same actions appear at three scopes (one player, a selection, a squad), so the labels that differ only by
// subject are named for the scope they belong to rather than shared.

export const swapNextLabel = Msgs.def(() => ({ text: () => 'Swap Next' }))

export const swapNowLabel = Msgs.def(() => ({ text: () => 'Swap Now' }))

export const killLabel = Msgs.def(() => ({ text: () => 'Kill' }))

export const kickLabel = Msgs.def(() => ({ text: () => 'Kick' }))

export const timeoutLabel = Msgs.def(() => ({ text: () => 'Timeout' }))

export const deleteSwapLabel = Msgs.def(() => ({ text: () => 'Delete Swap' }))

export const deleteSwapsLabel = Msgs.def(() => ({ text: () => 'Delete Swaps' }))

export const copyTeleportCommand = Msgs.def(() => ({ text: () => 'Copy Teleport Command' }))

export const removeFromSquadLabel = Msgs.def(() => ({ text: () => 'Remove from Squad' }))

export const disbandSquadLabel = Msgs.def(() => ({ text: () => 'Disband Squad' }))

export const resetSquadNameLabel = Msgs.def(() => ({ text: () => 'Reset Squad Name' }))

export const demoteCommanderLabel = Msgs.def(() => ({ text: () => 'Demote Commander' }))

export const swapSquadNextLabel = Msgs.def(() => ({ text: () => 'Swap Squad Next' }))

export const swapSquadNowLabel = Msgs.def(() => ({ text: () => 'Swap Squad Now' }))

export const killSquadLabel = Msgs.def(() => ({ text: () => 'Kill Squad' }))

export const kickSquadLabel = Msgs.def(() => ({ text: () => 'Kick Squad' }))

export const timeoutSquadLabel = Msgs.def(() => ({ text: () => 'Timeout Squad' }))

export const warnSquadLabel = Msgs.def(() => ({ text: () => 'Warn Squad' }))

export const warnLabel = Msgs.def(() => ({ text: () => 'Warn' }))

export const addFlagsToSquad = Msgs.def(() => ({ text: () => 'Add Flags to Squad...' }))

export const invertSelection = Msgs.def(() => ({ text: () => 'Invert Selection' }))

// reads as "<n> players selected"
export const playersSelected = Msgs.def(() => ({ text: () => 'players selected' }))

// -------- opening and copying a player's ids --------

export const openLinks = Msgs.def(() => ({ text: () => 'Open' }))

export const copyIds = Msgs.def(() => ({ text: () => 'Copy' }))

export const linkNames = { steam: 'Steam', cbl: 'CBL', mySquadStats: 'MySquadStats', battlemetrics: 'BattleMetrics' }

export const idNames = { username: 'Username', eos: 'EOS ID', steam: 'Steam ID', epic: 'Epic ID' }

// -------- the selection submenus --------
// The parenthesised value is what the row would select, so it belongs with the label rather than beside it.

export const selectFromTeam = Msgs.def(() => ({ text: () => 'Select from Team' }))

export const selectAll = Msgs.def(() => ({ text: () => 'Select All' }))

export const selectSquad = Msgs.def((squadName?: string) => ({ text: () => (squadName ? `Squad (${squadName})` : 'Squad') }))

export const selectRole = Msgs.def((role?: string) => ({ text: () => (role ? `Role (${role})` : 'Role') }))

export const selectGroup = Msgs.def((group?: string) => ({ text: () => (group ? `Group (${group})` : 'Group') }))

export const selectSquadLeaders = Msgs.def(() => ({ text: () => 'Squad Leaders' }))

export const selectAdmins = Msgs.def(() => ({ text: () => 'Admins' }))

export const selectInAdminCam = Msgs.def(() => ({ text: () => 'In Admin Cam' }))

export const selectAllPlayers = Msgs.def(() => ({ text: () => 'All Players' }))

export const invert = Msgs.def(() => ({ text: () => 'Invert' }))

export const selectSquadItem = Msgs.def(() => ({ text: () => 'Select Squad' }))

// The keyboard shortcut each selection row answers to. Ctrl widens it from one team to both, so every row has a
// pair; only the modifiers are fixed, the thing clicked is named.
export const shortcuts = {
	squadCell: { team: '⇧+click squad cell', all: '⇧+Ctrl+click squad cell' },
	roleCell: { team: '⇧+click role cell', all: '⇧+Ctrl+click role cell' },
	groupCell: { team: '⇧+click group cell', all: '⇧+Ctrl+click group cell' },
	adminBadge: { team: '⇧+click admin badge', all: '⇧+Ctrl+click admin badge' },
	cameraIcon: { team: '⇧+click camera icon', all: '⇧+Ctrl+click camera icon' },
	selectAllBox: { team: '⇧+click select-all box', all: '⇧+Ctrl+click select-all box' },
	invertBox: { team: 'Alt+click select-all box', all: 'Alt+Ctrl+click select-all box' },
}

export const selectSquadShortcutHint = Msgs.def(() => ({ text: () => 'Shortcut: shift+click the Squad cell in the teams panel' }))

// -------- the timeout dialog --------

export const timeoutDurationLabel = Msgs.def(() => ({ text: () => 'Timeout duration' }))

export const timeoutDurationPlaceholder = Msgs.def((max?: string) => ({
	text: () => (max === undefined ? 'e.g. 30m, 2h, 1d' : `e.g. 30m, 2h (max ${max})`),
}))

// -------- the roster --------

export const adminBadgeHint = Msgs.def(() => ({
	text: () => `This player is an Admin. Shift+click: select this team's admins. Shift+Ctrl+click: both teams`,
}))

export const squadLeaderBadge = Msgs.def(() => ({ text: () => 'Squad Leader' }))

export const failedToParseLayer = Msgs.def(() => ({ text: () => 'Failed to parse layer' }))

// -------- the teams panel --------

export const searchPlayers = Msgs.def(() => ({ text: () => 'Search Players...' }))

export const showSelected = Msgs.def(() => ({ text: () => 'Show Selected' }))

export const resetPanel = Msgs.def(() => ({ text: () => 'Reset selections, filters, sorting and search' }))

export const adminsOnly = Msgs.def(() => ({ text: () => 'Admins Only' }))

export const showSpoilers = Msgs.def(() => ({ text: () => 'Show Spoilers' }))

export const showSpoilersHint = Msgs.def(() => ({ text: () => 'Show K/W/D and role columns' }))

// the role filter survives spoilers being hidden, so it says so rather than silently narrowing the roster
export const hiddenRoleFilter = Msgs.def(() => ({ text: () => 'Role filter is active but hidden with spoilers' }))

export const roleFilterLabel = Msgs.def(() => ({ text: () => 'Role:' }))

export const clearRoleFilter = Msgs.def(() => ({ text: () => 'Clear role filter' }))

export const versus = Msgs.def(() => ({ text: () => 'vs' }))

export const timeoutsTab = Msgs.def(() => ({ text: () => 'Timeouts' }))

export const timeoutsTabHint = Msgs.def(() => ({ text: () => 'Show active kick timeouts' }))

export const groupingLabel = Msgs.def(() => ({ text: () => 'Grouping' }))

export const allGroupings = Msgs.def(() => ({ text: () => 'All' }))

export const clearFilter = Msgs.def(() => ({ text: () => 'Clear' }))

export const statsMayBeInaccurate = Msgs.def(() => ({
	text: () =>
		'Stats may be inaccurate: SLM was not active at some points during this match, so events during those periods were not counted.',
}))

// -------- the roster columns --------

export const selectRow = Msgs.def(() => ({ text: () => 'Select row' }))

export const selectAllRows = Msgs.def(() => ({ text: () => 'Select all' }))

export const groupColumn = Msgs.def(() => ({ text: () => 'Group' }))

export const roleColumn = Msgs.def(() => ({ text: () => 'Role' }))

export const squadColumn = Msgs.def(() => ({ text: () => 'Squad' }))

export const teamKillsColumn = Msgs.def(() => ({ text: () => 'TKs' }))

export const teamKillsHint = Msgs.def(() => ({ text: () => 'Team kills' }))

export const unassignedSquad = Msgs.def(() => ({ text: () => 'Unassigned' }))

// follows the squad name in the separator row
export const createdBy = Msgs.def((creator: string) => ({ text: () => `· created by ${creator}` }))

// how many of a squad's players the current filters leave visible
export const squadRowCount = Msgs.def((shown: number, total: number) => ({
	text: () => `${shown < total ? `${shown} of ` : ''}${total} ${total === 1 ? 'player' : 'players'}`,
}))

export const adminCamHint = Msgs.def(() => ({
	text: () => `In admin camera. Shift+click: select this team's players in admin cam. Shift+Ctrl+click: both teams`,
}))

export const squadLeaderColumnHint = Msgs.def(() => ({
	text: () => 'Shift+click: select squad leaders on this team. Shift+Ctrl+click: both teams',
}))

export const selectAllTeamHint = Msgs.def(() => ({
	text: () =>
		'Select all shown. Shift+click: select all on this team. Shift+Ctrl+click: both teams. Alt+click: invert selection on this team. ' +
		'Alt+Ctrl+click: invert on both teams',
}))

export const selectAllCombinedHint = Msgs.def(() => ({
	text: () => 'Select all shown. Shift+click: select all players on both teams. Alt+click: invert selection',
}))

export const teamTableLabel = Msgs.def((team: string | number) => ({ text: () => `Team ${team} players` }))

export const combinedTableLabel = Msgs.def(() => ({ text: () => 'All players' }))

// -------- the teamswap panel --------

export const teamsAfterSwap = Msgs.def(() => ({ text: () => 'Teams After Swap' }))

export const revertToSaved = Msgs.def(() => ({ text: () => 'Revert to saved' }))

export const toggleForceSaveHint = Msgs.def(() => ({ text: () => 'Toggle force save (save even if others are still editing)' }))

export const startEditing = Msgs.def(() => ({ text: () => 'Start Editing' }))

export const executeSwapsTitle = Msgs.def(() => ({ text: () => 'Execute team swaps?' }))

export const executeSwapsBlurb = Msgs.def(() => ({ text: () => 'This will immediately move all queued players to their assigned teams.' }))

export const cancel = Msgs.def(() => ({ text: () => 'Cancel' }))

export const help = Msgs.def(() => ({ text: () => 'Help' }))

export const swapsToCurrent = Msgs.def(() => ({ text: () => 'Swaps to current' }))

export const noSwapsYet = Msgs.def(() => ({ text: () => 'No swaps yet' }))

export const clearAllSwaps = Msgs.def(() => ({ text: () => 'Clear all' }))

export const deleteSwapAction = Msgs.def(() => ({ text: () => 'Delete swap' }))

export const middleClickDeleteSwap = Msgs.def(() => ({ text: () => 'Middle-click: delete swap' }))

// -------- the squad details window --------

export const playerDetailsTitle = Msgs.def(() => ({ text: () => 'Player Details' }))

export const squadWithId = Msgs.def((squadId: number) => ({ text: () => `Squad ${squadId}` }))

export const onlineFor = Msgs.def((elapsed?: string | null) => ({ text: () => (elapsed ? `Online for ${elapsed}` : 'Online') }))

export const lastSeen = Msgs.def((when: string) => ({ text: () => `Last seen ${when}` }))

export const offline = Msgs.def(() => ({ text: () => 'Offline' }))

export const playerActions = Msgs.def(() => ({ text: () => 'Player actions' }))

export const noSteamId = Msgs.def(() => ({ text: () => '(no steam id)' }))

export const warnPlayerPlaceholder = Msgs.def((playerName: string) => ({ text: () => `Warn ${playerName}…` }))

export const unnamedPlayer = Msgs.def(() => ({ text: () => 'player' }))

export const timedOutUntil = Msgs.def((expiresAt: string, reasonLabel?: string) => ({
	text: () => `Timed out until ${expiresAt}` + (reasonLabel ? ` (${reasonLabel})` : ''),
}))

// the divider the feed draws where it skipped a stretch of quiet: how long the gap ran, and where it picks up
export const feedGap = Msgs.def((gap: string, resumesAt: string) => ({ text: () => `${gap} later, resuming ${resumesAt}` }))

export const squadDetailsTitle = Msgs.def(() => ({ text: () => 'Squad Details' }))

export const squadLocked = Msgs.def(() => ({ text: () => 'Squad is locked' }))

export const squadActions = Msgs.def(() => ({ text: () => 'Squad actions' }))

export const squadCreator = Msgs.def(() => ({ text: () => 'Creator:' }))

export const squadTeam = Msgs.def(() => ({ text: () => 'Team' }))

export const squadInGameId = Msgs.def(() => ({ text: () => 'In-game ID:' }))

export const squadEvents = Msgs.def(() => ({ text: () => 'Squad Events' }))

export const hideTeamChat = Msgs.def(() => ({ text: () => 'Hide team/allchat' }))

export const squadPlayersHeading = Msgs.def((count: number) => ({ text: () => `Players (${count})` }))

export const noPlayersInSquad = Msgs.def(() => ({ text: () => 'No players' }))

export const warnSquadPlaceholder = Msgs.def((squadName: string) => ({ text: () => `Warn ${squadName}…` }))

// -------- the active-timeouts window --------

export const activeTimeoutsTitle = Msgs.def(() => ({ text: () => 'Active Timeouts' }))

export const activeTimeoutsBlurb = Msgs.def(() => ({
	text: () => 'Players with an active kick timeout are re-kicked on join from any SLM-managed server until it expires.',
}))

export const noActiveTimeouts = Msgs.def(() => ({ text: () => 'No active timeouts.' }))

export const timeoutPlayerColumn = Msgs.def(() => ({ text: () => 'Player' }))

export const timeoutExpiresColumn = Msgs.def(() => ({ text: () => 'Expires' }))

export const timeoutReasonColumn = Msgs.def(() => ({ text: () => 'Reason' }))

export const timeoutIssuedColumn = Msgs.def(() => ({ text: () => 'Issued' }))

export const noTimeoutReason = Msgs.def(() => ({ text: () => 'none' }))

export const cancelTimeoutHint = Msgs.def(() => ({ text: () => 'Cancel this timeout' }))

export const cancelTimeout = Msgs.def(() => ({ text: () => 'Cancel' }))

// who issued a timeout, when their account or in-game name cannot be resolved
export const timeoutActorFallbacks = { 'slm-user': 'Admin', 'ingame-user': 'In-game admin', system: 'System' }

// the id kinds a player row offers to copy
// A player id names its own kind, inline and in the copy button's tooltip. The button takes the kind rather than
// the label so the tooltip is a whole phrase rather than one built around a noun the caller passed in.
export type IdKind = 'steam' | 'eos' | 'epic'

export const idKindLabels: Record<IdKind, string> = { steam: 'steam', eos: 'eos', epic: 'epic' }

const copyIdHints: Record<IdKind, string> = { steam: 'Copy steam ID', eos: 'Copy eos ID', epic: 'Copy epic ID' }

export const copyIdHint = Msgs.def((kind: IdKind) => ({ text: () => copyIdHints[kind] }))

export const copiedFeedback = Msgs.def(() => ({ text: () => 'Copied!' }))
