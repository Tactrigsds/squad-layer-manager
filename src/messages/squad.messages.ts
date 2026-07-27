import * as Msgs from '@/messages/shared'
import type * as SM from '@/models/squad.models'

// a supplied reason is already the fully-rendered verbatim message; only the no-reason case gets a default
export const notifyKilled = Msgs.def((reason?: string) => ({
	warn: () => reason || 'You have been killed by an admin.',
}))

// Same shape, and it covers the plain kick and the timeout kick alike: the timeout's remaining duration is
// already substituted into the reason by the time it gets here.
export const notifyKicked = Msgs.def(
	'{hasReason, select, yes {{reason}} other {You have been kicked by an admin.}}',
	(reason?: string) => ({ reason, hasReason: reason ? 'yes' : 'no' }),
)

export const kill = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: Msgs.t('Kill {targetNoun}', { targetNoun: Msgs.targetNoun(target) }),
		description: Msgs.t(
			'Kill {targetSubject}? They will be force-switched teams twice in quick succession to trigger a respawn, ending back on their current team.',
			{ targetSubject: Msgs.targetSubject(target) },
		),
		confirmLabel: Msgs.t('Kill'),
	}),
	toast: () => [Msgs.t('Killed {targetAffected}', { targetAffected: Msgs.targetAffected(target) })],
}))

export const killFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Kill failed'), { description: reason }],
}))

export const kick = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: Msgs.t('Kick {targetNoun}', { targetNoun: Msgs.targetNoun(target) }),
		description: Msgs.t('Kick {targetSubject} from the server? They may rejoin immediately.', {
			targetSubject: Msgs.targetSubject(target),
		}),
		confirmLabel: Msgs.t('Kick'),
	}),
	toast: () => [Msgs.t('Kicked {targetAffected}', { targetAffected: Msgs.targetAffected(target) })],
}))

export const kickFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Kick failed'), { description: reason }],
}))

export const timeout = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: Msgs.t('Timeout {targetNoun}', { targetNoun: Msgs.targetNoun(target) }),
		description: Msgs.t('Kick {targetSubject}? They will be re-kicked on join from any SLM-managed server until the timeout expires.', {
			targetSubject: Msgs.targetSubject(target),
		}),
		confirmLabel: Msgs.t('Timeout'),
	}),
}))

export const timedOut = Msgs.def((target: Msgs.Target, duration: string) => ({
	toast: () => [Msgs.t('Timed out {targetAffected} for {duration}', { targetAffected: Msgs.targetAffected(target), duration })],
}))

export const timeoutFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Timeout failed'), { description: reason }],
}))

// a bulk timeout fans out one call per player, so some can fail while the rest succeed
export const timeoutCancelled = Msgs.def(() => ({ toast: () => [Msgs.t('Timeout cancelled')] }))

export const cancelTimeoutFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Cancel failed'), { description: reason }],
}))

export const someTimeoutsFailed = Msgs.def((count: number) => ({
	toast: () => [
		`${count} timeout${count === 1 ? '' : 's'} failed`,
		{ description: Msgs.t('They may already have an active timeout or have left the server.') },
	],
}))

export const invalidTimeoutDuration = Msgs.def(() => ({
	toast: () => [Msgs.t('Invalid duration'), { description: Msgs.t('Use a duration like 30m, 2h or 1d') }],
}))

export const timeoutTooLong = Msgs.def((maxDuration: string) => ({
	toast: () => [Msgs.t('Duration too long'), { description: Msgs.t('Your maximum timeout is {maxDuration}', { maxDuration }) }],
}))

export const warnPreset = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: Msgs.t('Warn {targetNoun}', { targetNoun: Msgs.targetNoun(target) }),
		description: Msgs.t('Warn {targetSubject} with a preset reason?', { targetSubject: Msgs.targetSubject(target) }),
		confirmLabel: Msgs.t('Warn'),
	}),
}))

export const warned = Msgs.def((target: Msgs.Target, presetReasonLabel: string) => ({
	toast: () => [
		Msgs.t('Warned {targetAffected} for {presetReasonLabel}', { targetAffected: Msgs.targetAffected(target), presetReasonLabel }),
	],
}))

export const warnFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Warn failed'), { description: reason }],
}))

// squadLabel is the quoted squad name, absent when the player's squad is not resolvable from live state
export const removeFromSquad = Msgs.def((target: Msgs.Target, squadLabel?: string) => ({
	confirm: () => ({
		title: Msgs.t('Remove from Squad'),
		description:
			target.kind === 'players'
				? `Remove ${target.count} players from their squads?`
				: `Remove this player from ${squadLabel ?? 'their squad'}?`,
		confirmLabel: Msgs.t('Remove'),
	}),
}))

// the three below are the loading/success/error legs of one toast.promise, which takes bare values rather than
// toast args, so they are `text` rather than `toast`
export const removingFromSquad = Msgs.def('Removing {count} players from their squads...', (count: number) => ({ count }))

export const removedFromSquad = Msgs.def('Removed {count} players from their squads', (count: number) => ({ count }))

export const removeFromSquadFailed = Msgs.def((count: number) => ({
	toast: () => [Msgs.t('Remove from squad failed'), { description: Msgs.t('Failed to remove {count} players', { count }) }],
}))

// teamId is named only from the player menu, where the squad is reached through one of its members and so is not
// otherwise identified on screen
export const disbandSquad = Msgs.def((squadLabel: string, teamId?: number) => ({
	confirm: () => ({
		title: Msgs.t('Disband Squad'),
		description: teamId === undefined ? `Disband squad ${squadLabel}?` : `Disband ${squadLabel} on team ${teamId}?`,
		confirmLabel: Msgs.t('Disband'),
	}),
}))

export const resetSquadName = Msgs.def((squadLabel: string) => ({
	confirm: () => ({
		title: Msgs.t('Reset Squad Name'),
		description: Msgs.t('Reset the name of {squadLabel} to default?', { squadLabel }),
		confirmLabel: Msgs.t('Reset'),
	}),
}))

export const demoteCommander = Msgs.def(() => ({
	confirm: () => ({
		title: Msgs.t('Demote Commander'),
		description: Msgs.t('Demote this player from commander?'),
		confirmLabel: Msgs.t('Demote'),
	}),
}))

export const copiedToClipboard = Msgs.def((what: string, count: number = 1) => ({
	toast: () => [Msgs.t('Copied'), { description: count > 1 ? `${count} ${what}s copied to clipboard` : `${what} copied to clipboard` }],
}))

// actionName is the admin action's display name, so the prompt says which action is being blocked
export const reasonRequired = Msgs.def((actionName: string) => ({
	toast: () => [Msgs.t('Reason required'), { description: Msgs.t('A reason is required for {actionName}.', { actionName }) }],
}))

// -------- the admin lists editor --------
// A list is a name, one source and the group permissions that mark an admin *in that list*. Its name is what
// servers and role assignments refer to.

export const noAdminLists = Msgs.def('No admin lists defined.')

export const newAdminListName = Msgs.def('new list name')

export const addAdminList = Msgs.def('Add list')

export const deleteAdminList = Msgs.def('Delete {name}', (name: string) => ({ name }))

export const adminListPicker = Msgs.def('Admin list')

export const selectAdminLists = Msgs.def('Select admin lists...')

// a list the server still names but the global settings no longer define; kept selectable so opening the editor
// cannot silently drop it
export const adminListNotConfigured = Msgs.def('{listId} (not configured)', (listId: string) => ({ listId }))

export const adminIdentifyingPermissions = Msgs.def('Admin-identifying permissions')

export const adminIdentifyingPermissionsHelp = Msgs.def(
	'Group permissions in this list that mark a player as an in-game admin on the servers using it.',
)

export const permissionPicker = Msgs.def('Permission')

export const selectPermissions = Msgs.def('Select permissions...')

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

export const sftpHost = Msgs.def('host')

export const sftpUsername = Msgs.def('username')

export const sftpPassword = Msgs.def('password')

export const sftpFilePath = Msgs.def('/path/to/Admins.cfg')

// A sandbox additionally has one SLM synthesises, which is not in the list because there is no source to name --
// so say so, rather than leaving the impression that an empty selection means the emulated server has no admins.
export const sandboxAdminListTitle = Msgs.def('This sandbox has an emulated admin list of its own')

export const sandboxAdminListBlurb = Msgs.def(
	'It applies on top of anything selected here and is edited from the sandbox control window (Server Actions -> Sandbox Controls), where you can define groups and tick which fabricated players are admins. There is no source to configure, because it only exists in memory.',
)

// -------- the player and squad context menus --------
// The same actions appear at three scopes (one player, a selection, a squad), so the labels that differ only by
// subject are named for the scope they belong to rather than shared.

export const swapNextLabel = Msgs.def('Swap Next')

export const swapNowLabel = Msgs.def('Swap Now')

export const killLabel = Msgs.def('Kill')

export const kickLabel = Msgs.def('Kick')

export const timeoutLabel = Msgs.def('Timeout')

export const deleteSwapLabel = Msgs.def('Delete Swap')

export const deleteSwapsLabel = Msgs.def('Delete Swaps')

export const copyTeleportCommand = Msgs.def('Copy Teleport Command')

export const removeFromSquadLabel = Msgs.def('Remove from Squad')

export const disbandSquadLabel = Msgs.def('Disband Squad')

export const resetSquadNameLabel = Msgs.def('Reset Squad Name')

export const demoteCommanderLabel = Msgs.def('Demote Commander')

export const swapSquadNextLabel = Msgs.def('Swap Squad Next')

export const swapSquadNowLabel = Msgs.def('Swap Squad Now')

export const killSquadLabel = Msgs.def('Kill Squad')

export const kickSquadLabel = Msgs.def('Kick Squad')

export const timeoutSquadLabel = Msgs.def('Timeout Squad')

export const warnSquadLabel = Msgs.def('Warn Squad')

export const warnLabel = Msgs.def('Warn')

export const addFlagsToSquad = Msgs.def('Add Flags to Squad...')

export const invertSelection = Msgs.def('Invert Selection')

// reads as "<n> players selected"
export const playersSelected = Msgs.def('players selected')

// -------- opening and copying a player's ids --------

export const openLinks = Msgs.def('Open')

export const copyIds = Msgs.def('Copy')

export const linkNames = { steam: 'Steam', cbl: 'CBL', mySquadStats: 'MySquadStats', battlemetrics: 'BattleMetrics' }

export const idNames = { username: 'Username', eos: 'EOS ID', steam: 'Steam ID', epic: 'Epic ID' }

// -------- the selection submenus --------
// The parenthesised value is what the row would select, so it belongs with the label rather than beside it.

export const selectFromTeam = Msgs.def('Select from Team')

export const selectAll = Msgs.def('Select All')

export const selectSquad = Msgs.def('Squad{named, select, yes { ({squadName})} other {}}', (squadName?: string) => ({
	squadName,
	named: squadName ? 'yes' : 'no',
}))

export const selectRole = Msgs.def('Role{named, select, yes { ({role})} other {}}', (role?: string) => ({
	role,
	named: role ? 'yes' : 'no',
}))

export const selectGroup = Msgs.def('Group{named, select, yes { ({group})} other {}}', (group?: string) => ({
	group,
	named: group ? 'yes' : 'no',
}))

export const selectSquadLeaders = Msgs.def('Squad Leaders')

export const selectAdmins = Msgs.def('Admins')

export const selectInAdminCam = Msgs.def('In Admin Cam')

export const selectAllPlayers = Msgs.def('All Players')

export const invert = Msgs.def('Invert')

export const selectSquadItem = Msgs.def('Select Squad')

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

export const selectSquadShortcutHint = Msgs.def('Shortcut: shift+click the Squad cell in the teams panel')

// -------- the timeout dialog --------

export const timeoutDurationLabel = Msgs.def('Timeout duration')

export const timeoutDurationPlaceholder = Msgs.def(
	'{capped, select, yes {e.g. 30m, 2h (max {max})} other {e.g. 30m, 2h, 1d}}',
	(max?: string) => ({ max, capped: max === undefined ? 'no' : 'yes' }),
)

// -------- the roster --------

export const adminBadgeHint = Msgs.def(
	"This player is an Admin. Shift+click: select this team's admins. Shift+Ctrl+click: both teams",
	() => ({}),
)

export const squadLeaderBadge = Msgs.def('Squad Leader')

export const failedToParseLayer = Msgs.def('Failed to parse layer')

// -------- the teams panel --------

export const searchPlayers = Msgs.def('Search Players...')

export const showSelected = Msgs.def('Show Selected')

export const resetPanel = Msgs.def('Reset selections, filters, sorting and search')

export const adminsOnly = Msgs.def('Admins Only')

export const showSpoilers = Msgs.def('Show Spoilers')

export const showSpoilersHint = Msgs.def('Show K/W/D and role columns')

// the role filter survives spoilers being hidden, so it says so rather than silently narrowing the roster
export const hiddenRoleFilter = Msgs.def('Role filter is active but hidden with spoilers')

export const roleFilterLabel = Msgs.def('Role:')

export const clearRoleFilter = Msgs.def('Clear role filter')

export const versus = Msgs.def('vs')

export const timeoutsTab = Msgs.def('Timeouts')

export const timeoutsTabHint = Msgs.def('Show active kick timeouts')

export const groupingLabel = Msgs.def('Grouping')

export const allGroupings = Msgs.def('All')

export const clearFilter = Msgs.def('Clear')

export const statsMayBeInaccurate = Msgs.def(
	'Stats may be inaccurate: SLM was not active at some points during this match, so events during those periods were not counted.',
)

// -------- the roster columns --------

export const selectRow = Msgs.def('Select row')

export const selectAllRows = Msgs.def('Select all')

export const groupColumn = Msgs.def('Group')

export const roleColumn = Msgs.def('Role')

export const squadColumn = Msgs.def('Squad')

export const teamKillsColumn = Msgs.def('TKs')

export const teamKillsHint = Msgs.def('Team kills')

export const unassignedSquad = Msgs.def('Unassigned')

// follows the squad name in the separator row
export const createdBy = Msgs.def('· created by {creator}', (creator: string) => ({ creator }))

// how many of a squad's players the current filters leave visible
export const squadRowCount = Msgs.def(
	'{partial, select, yes {{shown} of } other {}}{total, plural, one {# player} other {# players}}',
	(shown: number, total: number) => ({ shown, total, partial: shown < total ? 'yes' : 'no' }),
)

export const adminCamHint = Msgs.def(
	"In admin camera. Shift+click: select this team's players in admin cam. Shift+Ctrl+click: both teams",
	() => ({}),
)

export const squadLeaderColumnHint = Msgs.def('Shift+click: select squad leaders on this team. Shift+Ctrl+click: both teams')

export const selectAllTeamHint = Msgs.def(
	'Select all shown. Shift+click: select all on this team. Shift+Ctrl+click: both teams. Alt+click: invert selection on this team. Alt+Ctrl+click: invert on both teams',
)

export const selectAllCombinedHint = Msgs.def(
	'Select all shown. Shift+click: select all players on both teams. Alt+click: invert selection',
)

export const teamTableLabel = Msgs.def('Team {team} players', (team: string | number) => ({ team }))

export const combinedTableLabel = Msgs.def('All players')

// -------- the teamswap panel --------

export const teamsAfterSwap = Msgs.def('Teams After Swap')

export const revertToSaved = Msgs.def('Revert to saved')

export const toggleForceSaveHint = Msgs.def('Toggle force save (save even if others are still editing)')

export const startEditing = Msgs.def('Start Editing')

export const executeSwapsTitle = Msgs.def('Execute team swaps?')

export const executeSwapsBlurb = Msgs.def('This will immediately move all queued players to their assigned teams.')

export const cancel = Msgs.def('Cancel')

export const help = Msgs.def('Help')

export const swapsToCurrent = Msgs.def('Swaps to current')

export const noSwapsYet = Msgs.def('No swaps yet')

export const clearAllSwaps = Msgs.def('Clear all')

export const deleteSwapAction = Msgs.def('Delete swap')

export const middleClickDeleteSwap = Msgs.def('Middle-click: delete swap')

// -------- the squad details window --------

export const playerDetailsTitle = Msgs.def('Player Details')

export const squadWithId = Msgs.def('Squad {squadId}', (squadId: number) => ({ squadId }))

export const onlineFor = Msgs.def('Online{known, select, yes { for {elapsed}} other {}}', (elapsed?: string | null) => ({
	elapsed,
	known: elapsed ? 'yes' : 'no',
}))

export const lastSeen = Msgs.def('Last seen {when}', (when: string) => ({ when }))

export const offline = Msgs.def('Offline')

export const playerActions = Msgs.def('Player actions')

export const noSteamId = Msgs.def('(no steam id)')

export const warnPlayerPlaceholder = Msgs.def('Warn {playerName}…', (playerName: string) => ({ playerName }))

export const unnamedPlayer = Msgs.def('player')

export const timedOutUntil = Msgs.def(
	'Timed out until {expiresAt}{hasReason, select, yes { ({reasonLabel})} other {}}',
	(expiresAt: string, reasonLabel?: string) => ({ expiresAt, reasonLabel, hasReason: reasonLabel ? 'yes' : 'no' }),
)

// the divider the feed draws where it skipped a stretch of quiet: how long the gap ran, and where it picks up
export const feedGap = Msgs.def('{gap} later, resuming {resumesAt}', (gap: string, resumesAt: string) => ({ gap, resumesAt }))

export const squadDetailsTitle = Msgs.def('Squad Details')

export const squadLocked = Msgs.def('Squad is locked')

export const squadActions = Msgs.def('Squad actions')

export const squadCreator = Msgs.def('Creator:')

export const squadTeam = Msgs.def('Team')

export const squadInGameId = Msgs.def('In-game ID:')

export const squadEvents = Msgs.def('Squad Events')

export const hideTeamChat = Msgs.def('Hide team/allchat')

export const squadPlayersHeading = Msgs.def('Players ({count})', (count: number) => ({ count }))

export const noPlayersInSquad = Msgs.def('No players')

export const warnSquadPlaceholder = Msgs.def('Warn {squadName}…', (squadName: string) => ({ squadName }))

// -------- the active-timeouts window --------

export const activeTimeoutsTitle = Msgs.def('Active Timeouts')

export const activeTimeoutsBlurb = Msgs.def(
	'Players with an active kick timeout are re-kicked on join from any SLM-managed server until it expires.',
)

export const noActiveTimeouts = Msgs.def('No active timeouts.')

export const timeoutPlayerColumn = Msgs.def('Player')

export const timeoutExpiresColumn = Msgs.def('Expires')

export const timeoutReasonColumn = Msgs.def('Reason')

export const timeoutIssuedColumn = Msgs.def('Issued')

export const noTimeoutReason = Msgs.def('none')

export const cancelTimeoutHint = Msgs.def('Cancel this timeout')

export const cancelTimeout = Msgs.def('Cancel')

// who issued a timeout, when their account or in-game name cannot be resolved
export const timeoutActorFallbacks = { 'slm-user': 'Admin', 'ingame-user': 'In-game admin', system: 'System' }

// the id kinds a player row offers to copy
// A player id names its own kind, inline and in the copy button's tooltip. The button takes the kind rather than
// the label so the tooltip is a whole phrase rather than one built around a noun the caller passed in.
export type IdKind = 'steam' | 'eos' | 'epic'

export const idKindLabels: Record<IdKind, string> = { steam: 'steam', eos: 'eos', epic: 'epic' }

export const copyIdHint = Msgs.def('Copy {kind} ID', (kind: IdKind) => ({ kind: idKindLabels[kind] }))

export const copiedFeedback = Msgs.def('Copied!')
