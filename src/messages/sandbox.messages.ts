import * as Msgs from '@/messages/shared'

// The sandbox window drives an emulated server, so its failures are the emulator's own words where it has any and
// the verb's result code otherwise.
export const verbFailed = Msgs.def((reason: string) => ({
	toast: () => ['Sandbox', { description: reason }],
}))

export const bulkJoinNeedsCount = Msgs.def(() => ({
	toast: () => ['Sandbox', { description: 'Enter how many players should connect' }],
}))

export const windowTitle = Msgs.def('Sandbox')

export const windowTitleFor = Msgs.def('Sandbox: {serverId}', (serverId: string) => ({ serverId }))

export const unavailable = Msgs.def('This server is no longer an available sandbox.')

export const blurb = Msgs.def('This server is emulated. Players here are fabricated and nothing said or done reaches anyone real.')

export const playersSection = Msgs.def('Players')

export const bulkJoinCountPlaceholder = Msgs.def('10')

export const bulkJoin = Msgs.def('Bulk join')

export const serverFull = Msgs.def('Full ({maxPlayers} players)', (maxPlayers: number) => ({ maxPlayers }))

export const join = Msgs.def('Join')

export const matchSection = Msgs.def('Match')

export const endMatch = Msgs.def('End match')

export const teamWins = Msgs.def('Team {teamId} wins', (teamId: 1 | 2) => ({ teamId }))

export const dropRcon = Msgs.def('Drop RCON')

export const adminListSection = Msgs.def('Admin list')

export const popOut = Msgs.def('Pop out')

export const consoleSection = Msgs.def('Server console')

export const nobodyConnected = Msgs.def('Nobody connected.')

export const searchPlayers = Msgs.def('Search players')

export const searchPlayersLabel = Msgs.def('Search players by name')

export const noPlayerMatches = Msgs.def('No player matches that name.')

export const playerColumn = Msgs.def('Player')

export const teamColumn = Msgs.def('Team')

export const squadColumn = Msgs.def('Squad')

export const adminColumn = Msgs.def('Admin')

export const groupsColumn = Msgs.def('Groups')

export const isAdminCheckbox = Msgs.def('{playerName} is an admin', (playerName: string) => ({ playerName }))

export const groupPicker = Msgs.def('Group')

export const noGroups = Msgs.def('None')

export const disconnectPlayer = Msgs.def('Disconnect {playerName}', (playerName: string) => ({ playerName }))

export const previousPage = Msgs.def('Previous page')

export const nextPage = Msgs.def('Next page')

export const saySection = Msgs.def('Say')

export const speakerPlaceholder = Msgs.def('as...')

export const messagePlaceholder = Msgs.def('!vote 1')

export const send = Msgs.def('Send')

export const adminChatNeedsAdmin = Msgs.def('Admin chat needs an admin. Tick Admin next to a player above.')

export const adminsCfgTitle = Msgs.def('Admins.cfg: {serverId}', (serverId: string) => ({ serverId }))

export const adminListEmpty = Msgs.def('The emulated admin list is empty.')
