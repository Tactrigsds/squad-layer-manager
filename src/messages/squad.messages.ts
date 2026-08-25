import * as Tgt from '@/messages/target'
import { def, raw, t, type TString } from '@/models/messages.models'
import type * as SM from '@/models/squad.models'

// a supplied reason is already the fully-rendered verbatim message; only the no-reason case gets a default
export const notifyKilled = def((reason?: string) => ({
	warn: t('{hasReason, select, yes {{reason}} other {You have been killed by an admin.}}', {
		reason,
		hasReason: reason ? 'yes' : 'no',
	}),
}))

// Same shape, and it covers the plain kick and the timeout kick alike: the timeout's remaining duration is
// already substituted into the reason by the time it gets here.
export const notifyKicked = def('{hasReason, select, yes {{reason}} other {You have been kicked by an admin.}}', (reason?: string) => ({
	reason,
	hasReason: reason ? 'yes' : 'no',
}))

export const kill = def((target: Tgt.Target) => ({
	confirm: {
		title: t('Kill {targetNoun}', { targetNoun: Tgt.noun(target) }),
		description: t(
			'Kill {targetSubject}? They will be force-switched teams twice in quick succession to trigger a respawn, ending back on their current team.',
			{ targetSubject: Tgt.subject(target) },
		),
		confirmLabel: t('Kill'),
	},
	toast: [t('Killed {targetAffected}', { targetAffected: Tgt.affected(target) })],
}))

export const killFailed = def((reason: string) => ({
	toast: [t('Kill failed'), { description: raw(reason) }],
}))

export const kick = def((target: Tgt.Target) => ({
	confirm: {
		title: t('Kick {targetNoun}', { targetNoun: Tgt.noun(target) }),
		description: t('Kick {targetSubject} from the server? They may rejoin immediately.', {
			targetSubject: Tgt.subject(target),
		}),
		confirmLabel: t('Kick'),
	},
	toast: [t('Kicked {targetAffected}', { targetAffected: Tgt.affected(target) })],
}))

export const kickFailed = def((reason: string) => ({
	toast: [t('Kick failed'), { description: raw(reason) }],
}))

export const timeout = def((target: Tgt.Target) => ({
	confirm: {
		title: t('Timeout {targetNoun}', { targetNoun: Tgt.noun(target) }),
		description: t('Kick {targetSubject}? They will be re-kicked on join from any SLM-managed server until the timeout expires.', {
			targetSubject: Tgt.subject(target),
		}),
		confirmLabel: t('Timeout'),
	},
}))

export const timedOut = def((target: Tgt.Target, duration: string) => ({
	toast: [t('Timed out {targetAffected} for {duration}', { targetAffected: Tgt.affected(target), duration })],
}))

export const timeoutFailed = def((reason: string) => ({
	toast: [t('Timeout failed'), { description: raw(reason) }],
}))

// a bulk timeout fans out one call per player, so some can fail while the rest succeed
export const timeoutCancelled = def(() => ({ toast: [t('Timeout cancelled')] }))

export const cancelTimeoutFailed = def((reason: string) => ({
	toast: [t('Cancel failed'), { description: raw(reason) }],
}))

export const someTimeoutsFailed = def((count: number) => ({
	toast: [
		t('{count, plural, one {# timeout failed} other {# timeouts failed}}', { count }),
		{ description: t('They may already have an active timeout or have left the server.') },
	],
}))

export const invalidTimeoutDuration = def(() => ({
	toast: [t('Invalid duration'), { description: t('Use a duration like 30m, 2h or 1d') }],
}))

export const timeoutTooLong = def((maxDuration: string) => ({
	toast: [t('Duration too long'), { description: t('Your maximum timeout is {maxDuration}', { maxDuration }) }],
}))

export const warnPreset = def((target: Tgt.Target) => ({
	confirm: {
		title: t('Warn {targetNoun}', { targetNoun: Tgt.noun(target) }),
		description: t('Warn {targetSubject} with a preset reason?', { targetSubject: Tgt.subject(target) }),
		confirmLabel: t('Warn'),
	},
}))

export const warned = def((target: Tgt.Target, presetReasonLabel: string) => ({
	toast: [t('Warned {targetAffected} for {presetReasonLabel}', { targetAffected: Tgt.affected(target), presetReasonLabel })],
}))

export const warnFailed = def((reason: string) => ({
	toast: [t('Warn failed'), { description: raw(reason) }],
}))

// squadLabel is the quoted squad name, absent when the player's squad is not resolvable from live state
export const removeFromSquad = def((target: Tgt.Target, squadLabel?: string) => ({
	confirm: {
		title: t('Remove from Squad'),
		description:
			target.kind === 'players'
				? t('Remove {count, plural, one {# player} other {# players}} from their squads?', { count: target.count })
				: t('Remove this player from {squadLabel}?', { squadLabel: squadLabel ?? t('their squad') }),
		confirmLabel: t('Remove'),
	},
}))

// the three below are the loading/success/error legs of one toast.promise, which takes bare values rather than
// toast args, so they are `text` rather than `toast`
export const removingFromSquad = def('Removing {count} players from their squads...', (count: number) => ({ count }))

export const removedFromSquad = def('Removed {count} players from their squads', (count: number) => ({ count }))

export const removeFromSquadFailed = def((count: number) => ({
	toast: [t('Remove from squad failed'), { description: t('Failed to remove {count} players', { count }) }],
}))

// teamId is named only from the player menu, where the squad is reached through one of its members and so is not
// otherwise identified on screen
export const disbandSquad = def((squadLabel: string, teamId?: number) => ({
	confirm: {
		title: t('Disband Squad'),
		description:
			teamId === undefined
				? t('Disband squad {squadLabel}?', { squadLabel })
				: t('Disband {squadLabel} on team {teamId}?', { squadLabel, teamId }),
		confirmLabel: t('Disband'),
	},
}))

export const resetSquadName = def((squadLabel: string) => ({
	confirm: {
		title: t('Reset Squad Name'),
		description: t('Reset the name of {squadLabel} to default?', { squadLabel }),
		confirmLabel: t('Reset'),
	},
}))

export const demoteCommander = def(() => ({
	confirm: {
		title: t('Demote Commander'),
		description: t('Demote this player from commander?'),
		confirmLabel: t('Demote'),
	},
}))

export const copiedToClipboard = def((what: string, count: number = 1) => ({
	toast: [
		t('Copied'),
		{ description: t('{count, plural, one {{what} copied to clipboard} other {# {what}s copied to clipboard}}', { count, what }) },
	],
}))

// actionName is the admin action's display name, so the prompt says which action is being blocked
export const reasonRequired = def((actionName: string) => ({
	toast: [t('Reason required'), { description: t('A reason is required for {actionName}.', { actionName }) }],
}))

// -------- the admin lists editor --------
// A list is a name, one source and the group permissions that mark an admin *in that list*. Its name is what
// servers and role assignments refer to.

export const noAdminLists = def('No admin lists defined.')

export const newAdminListName = def('new list name')

export const addAdminList = def('Add list')

export const deleteAdminList = def('Delete {name}', (name: string) => ({ name }))

export const adminListPicker = def('Admin list')

export const selectAdminLists = def('Select admin lists...')

// a list the server still names but the global settings no longer define; kept selectable so opening the editor
// cannot silently drop it
export const adminListNotConfigured = def('{listId} (not configured)', (listId: string) => ({ listId }))

export const adminIdentifyingPermissions = def('Admin-identifying permissions')

export const adminIdentifyingPermissionsHelp = def(
	'Group permissions in this list that mark a player as an in-game admin on the servers using it.',
)

export const permissionPicker = def('Permission')

export const selectPermissions = def('Select permissions...')

// how each source kind is named in the picker, and what its one string field looks like
export const adminSourceTypeLabels: Record<SM.AdminListSourceType, TString> = {
	remote: t('Remote URL'),
	local: t('Local file'),
	ftp: t('FTP'),
	sftp: t('SFTP'),
}

export const adminSourcePlaceholders: Record<Exclude<SM.AdminListSourceType, 'sftp'>, string> = {
	remote: 'https://host/admins.cfg',
	local: 'path/to/Admins.cfg',
	ftp: 'ftp://user:password@host:21/admins.cfg',
}

export const sftpHost = def('host')

export const sftpUsername = def('username')

export const sftpPassword = def('password')

export const sftpFilePath = def('/path/to/Admins.cfg')

// A sandbox additionally has one SLM synthesises, which is not in the list because there is no source to name --
// so say so, rather than leaving the impression that an empty selection means the emulated server has no admins.
export const sandboxAdminListTitle = def('This sandbox has an emulated admin list of its own')

export const sandboxAdminListBlurb = def(
	'It applies on top of anything selected here and is edited from the sandbox control window (Server Actions -> Sandbox Controls), where you can define groups and tick which fabricated players are admins. There is no source to configure, because it only exists in memory.',
)

// -------- the player and squad context menus --------
// The same actions appear at three scopes (one player, a selection, a squad), so the labels that differ only by
// subject are named for the scope they belong to rather than shared.

export const swapNextLabel = def('Swap Next')

export const swapNowLabel = def('Swap Now')

export const killLabel = def('Kill')

export const kickLabel = def('Kick')

export const timeoutLabel = def('Timeout')

export const deleteSwapLabel = def('Delete Swap')

export const deleteSwapsLabel = def('Delete Swaps')

export const copyTeleportCommand = def('Copy Teleport Command')

export const removeFromSquadLabel = def('Remove from Squad')

export const disbandSquadLabel = def('Disband Squad')

export const resetSquadNameLabel = def('Reset Squad Name')

export const demoteCommanderLabel = def('Demote Commander')

export const swapSquadNextLabel = def('Swap Squad Next')

export const swapSquadNowLabel = def('Swap Squad Now')

export const killSquadLabel = def('Kill Squad')

export const kickSquadLabel = def('Kick Squad')

export const timeoutSquadLabel = def('Timeout Squad')

export const warnSquadLabel = def('Warn Squad')

export const warnLabel = def('Warn')

export const addFlagsToSquad = def('Add Flags to Squad...')

export const invertSelection = def('Invert Selection')

// reads as "<n> players selected"
export const playersSelected = def('players selected')

// -------- opening and copying a player's ids --------

export const openLinks = def('Open')

export const copyIds = def('Copy')

export const linkNames = { steam: 'Steam', cbl: 'CBL', mySquadStats: 'MySquadStats', battlemetrics: 'BattleMetrics' }

export const idNames = { username: 'Username', eos: 'EOS ID', steam: 'Steam ID', epic: 'Epic ID' }

// -------- the selection submenus --------
// The parenthesised value is what the row would select, so it belongs with the label rather than beside it.

export const selectFromTeam = def('Select from Team')

export const selectAll = def('Select All')

export const selectSquad = def('Squad{named, select, yes { ({squadName})} other {}}', (squadName?: string) => ({
	squadName,
	named: squadName ? 'yes' : 'no',
}))

export const selectRole = def('Role{named, select, yes { ({role})} other {}}', (role?: string) => ({
	role,
	named: role ? 'yes' : 'no',
}))

export const selectGroup = def('Group{named, select, yes { ({group})} other {}}', (group?: string) => ({
	group,
	named: group ? 'yes' : 'no',
}))

export const selectSquadLeaders = def('Squad Leaders')

export const selectAdmins = def('Admins')

export const selectInAdminCam = def('In Admin Cam')

export const selectAllPlayers = def('All Players')

export const invert = def('Invert')

export const selectSquadItem = def('Select Squad')

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

export const selectSquadShortcutHint = def('Shortcut: shift+click the Squad cell in the teams panel')

// -------- the timeout dialog --------

export const timeoutDurationLabel = def('Timeout duration')

export const timeoutDurationPlaceholder = def(
	'{capped, select, yes {e.g. 30m, 2h (max {max})} other {e.g. 30m, 2h, 1d}}',
	(max?: string) => ({ max, capped: max === undefined ? 'no' : 'yes' }),
)

// -------- the roster --------

export const adminBadgeHint = def(
	"This player is an Admin. Shift+click: select this team's admins. Shift+Ctrl+click: both teams",
	() => ({}),
)

export const squadLeaderBadge = def('Squad Leader')

export const failedToParseLayer = def('Failed to parse layer')

// -------- the teams panel --------

export const searchPlayers = def('Search Players...')

export const showSelected = def('Show Selected')

export const resetPanel = def('Reset selections, filters, sorting and search')

export const adminsOnly = def('Admins Only')

export const showSpoilers = def('Show Spoilers')

export const showSpoilersHint = def('Show K/W/D and role columns')

// the role filter survives spoilers being hidden, so it says so rather than silently narrowing the roster
export const hiddenRoleFilter = def('Role filter is active but hidden with spoilers')

export const roleFilterLabel = def('Role:')

export const clearRoleFilter = def('Clear role filter')

export const versus = def('vs')

export const timeoutsTab = def('Timeouts')

export const timeoutsTabHint = def('Show active kick timeouts')

export const groupingLabel = def('Grouping')

export const allGroupings = def('All')

export const clearFilter = def('Clear')

export const statsMayBeInaccurate = def(
	'Stats may be inaccurate: SLM was not active at some points during this match, so events during those periods were not counted.',
)

// -------- the roster columns --------

export const selectRow = def('Select row')

export const selectAllRows = def('Select all')

export const groupColumn = def('Group')

export const roleColumn = def('Role')

export const squadColumn = def('Squad')

export const teamKillsColumn = def('TKs')

export const teamKillsHint = def('Team kills')

export const unassignedSquad = def('Unassigned')

// follows the squad name in the separator row
export const createdBy = def('· created by {creator}', (creator: string) => ({ creator }))

// how many of a squad's players the current filters leave visible
export const squadRowCount = def(
	'{partial, select, yes {{shown} of } other {}}{total, plural, one {# player} other {# players}}',
	(shown: number, total: number) => ({ shown, total, partial: shown < total ? 'yes' : 'no' }),
)

export const adminCamHint = def(
	"In admin camera. Shift+click: select this team's players in admin cam. Shift+Ctrl+click: both teams",
	() => ({}),
)

export const squadLeaderColumnHint = def('Shift+click: select squad leaders on this team. Shift+Ctrl+click: both teams')

export const selectAllTeamHint = def(
	'Select all shown. Shift+click: select all on this team. Shift+Ctrl+click: both teams. Alt+click: invert selection on this team. Alt+Ctrl+click: invert on both teams',
)

export const selectAllCombinedHint = def('Select all shown. Shift+click: select all players on both teams. Alt+click: invert selection')

// the table is only labelled for a screen reader, so the team carries its faction the way the visible header does
export const teamTableLabel = def('{team} players', (team: string) => ({ team }))

export const combinedTableLabel = def('All players')

// -------- the teamswap panel --------

export const teamsAfterSwap = def('Teams After Swap')

export const revertToSaved = def('Revert to saved')

export const toggleForceSaveHint = def('Toggle force save (save even if others are still editing)')

export const startEditing = def('Start Editing')

export const executeSwapsTitle = def('Execute team swaps?')

export const executeSwapsBlurb = def('This will immediately move all queued players to their assigned teams.')

export const cancel = def('Cancel')

export const help = def('Help')

export const swapsToCurrent = def('Swaps to current')

export const noSwapsYet = def('No swaps yet')

export const clearAllSwaps = def('Clear all')

export const deleteSwapAction = def('Delete swap')

export const middleClickDeleteSwap = def('Middle-click: delete swap')

// -------- the squad details window --------

export const playerDetailsTitle = def('Player Details')

export const squadWithId = def('Squad {squadId}', (squadId: number) => ({ squadId }))

export const onlineFor = def('Online{known, select, yes { for {elapsed}} other {}}', (elapsed?: string | null) => ({
	elapsed,
	known: elapsed ? 'yes' : 'no',
}))

export const lastSeen = def('Last seen {when}', (when: string) => ({ when }))

export const offline = def('Offline')

export const playerActions = def('Player actions')

export const noSteamId = def('(no steam id)')

export const warnPlayerPlaceholder = def('Warn {playerName}…', (playerName: string) => ({ playerName }))

export const unnamedPlayer = def('player')

export const timedOutUntil = def(
	'Timed out until {expiresAt}{hasReason, select, yes { ({reasonLabel})} other {}}',
	(expiresAt: string, reasonLabel?: string) => ({ expiresAt, reasonLabel, hasReason: reasonLabel ? 'yes' : 'no' }),
)

// the divider the feed draws where it skipped a stretch of quiet: how long the gap ran, and where it picks up
export const feedGap = def('{gap} later, resuming {resumesAt}', (gap: string, resumesAt: string) => ({ gap, resumesAt }))

export const squadDetailsTitle = def('Squad Details')

export const squadLocked = def('Squad is locked')

export const squadActions = def('Squad actions')

export const squadCreator = def('Creator:')

export const squadTeam = def('Team')

export const squadInGameId = def('In-game ID:')

export const squadEvents = def('Squad Events')

export const hideTeamChat = def('Hide team/allchat')

export const squadPlayersHeading = def('Players ({count})', (count: number) => ({ count }))

export const noPlayersInSquad = def('No players')

export const warnSquadPlaceholder = def('Warn {squadName}…', (squadName: string) => ({ squadName }))

// -------- the active-timeouts window --------

export const activeTimeoutsTitle = def('Active Timeouts')

export const activeTimeoutsBlurb = def(
	'Players with an active kick timeout are re-kicked on join from any SLM-managed server until it expires.',
)

export const noActiveTimeouts = def('No active timeouts.')

export const timeoutPlayerColumn = def('Player')

export const timeoutExpiresColumn = def('Expires')

export const timeoutReasonColumn = def('Reason')

export const timeoutIssuedColumn = def('Issued')

export const noTimeoutReason = def('none')

export const cancelTimeoutHint = def('Cancel this timeout')

export const cancelTimeout = def('Cancel')

// who issued a timeout, when their account or in-game name cannot be resolved
export const timeoutActorFallbacks = { 'slm-user': 'Admin', 'ingame-user': 'In-game admin', system: 'System' }

export type IdKind = Exclude<SM.PlayerIds.Fields, 'usernameNoTag'>

export const idKindLabels: Record<IdKind, string> = {
	steam: 'SteamID',
	eos: 'EOSID',
	epic: 'Epic',
	username: 'Username',
	playerController: 'PlayerController',
}
export function isCopyableIdKind(kind: string): kind is IdKind {
	return kind in idKindLabels
}

export const copyIdHint = def('Copy {kind}', (kind: IdKind) => ({ kind: idKindLabels[kind] }))

export const copiedFeedback = def('Copied!')
