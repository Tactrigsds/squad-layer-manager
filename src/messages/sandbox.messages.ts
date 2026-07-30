import { def, raw, t } from '@/models/messages.models'

// The sandbox window drives an emulated server, so its failures are the emulator's own words where it has any and
// the verb's result code otherwise.
export const verbFailed = def((reason: string) => ({
	toast: [t('Sandbox'), { description: raw(reason) }],
}))

export const bulkJoinNeedsCount = def(() => ({
	toast: [t('Sandbox'), { description: t('Enter how many players should connect') }],
}))

export const windowTitle = def('Sandbox')

export const windowTitleFor = def('Sandbox: {serverId}', (serverId: string) => ({ serverId }))

export const unavailable = def('This server is no longer an available sandbox.')

export const blurb = def('This server is emulated. Players here are fabricated and nothing said or done reaches anyone real.')

export const playersSection = def('Players')

export const bulkJoinCountPlaceholder = def('10')

export const bulkJoin = def('Bulk join')

export const serverFull = def('Full ({maxPlayers} players)', (maxPlayers: number) => ({ maxPlayers }))

export const join = def('Join')

export const matchSection = def('Match')

export const endMatch = def('End match')

export const teamWins = def('Team {teamId} wins', (teamId: 1 | 2) => ({ teamId }))

export const dropRcon = def('Drop RCON')

export const adminListSection = def('Admin list')

export const popOut = def('Pop out')

export const consoleSection = def('Server console')

export const nobodyConnected = def('Nobody connected.')

export const searchPlayers = def('Search players')

export const searchPlayersLabel = def('Search players by name')

export const noPlayerMatches = def('No player matches that name.')

export const playerColumn = def('Player')

export const teamColumn = def('Team')

export const squadColumn = def('Squad')

export const adminColumn = def('Admin')

export const teamPicker = def("{playerName}'s team", (playerName: string) => ({ playerName }))

export const teamOption = def('Team {teamId}', (teamId: number) => ({ teamId }))

export const noTeam = def('No team')

export const squadPicker = def("{playerName}'s squad", (playerName: string) => ({ playerName }))

export const squadOption = def('{squadId}. {squadName} ({size})', (squadId: number, squadName: string, size: number) => ({
	squadId,
	squadName,
	size,
}))

export const noSquad = def('No squad')

export const createSquad = def('Create squad')

export const squadLeader = def('{playerName} leads this squad', (playerName: string) => ({ playerName }))

export const groupsColumn = def('Groups')

export const isAdminCheckbox = def('{playerName} is an admin', (playerName: string) => ({ playerName }))

export const groupPicker = def('Group')

export const noGroups = def('None')

export const disconnectPlayer = def('Disconnect {playerName}', (playerName: string) => ({ playerName }))

export const previousPage = def('Previous page')

export const nextPage = def('Next page')

export const saySection = def('Say')

export const speakerPlaceholder = def('as...')

export const messagePlaceholder = def('!vote 1')

export const send = def('Send')

export const adminChatNeedsAdmin = def('Admin chat needs an admin. Tick Admin next to a player above.')

export const adminsCfgTitle = def('Admins.cfg: {serverId}', (serverId: string) => ({ serverId }))

export const adminListEmpty = def('The emulated admin list is empty.')
