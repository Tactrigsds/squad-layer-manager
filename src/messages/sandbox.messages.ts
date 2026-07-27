import * as Msgs from '@/messages/shared'

// The sandbox window drives an emulated server, so its failures are the emulator's own words where it has any and
// the verb's result code otherwise.
export const verbFailed = Msgs.def((reason: string) => ({
	toast: () => ['Sandbox', { description: reason }],
}))

export const bulkJoinNeedsCount = Msgs.def(() => ({
	toast: () => ['Sandbox', { description: 'Enter how many players should connect' }],
}))

export const windowTitle = Msgs.def(() => ({ text: () => 'Sandbox' }))

export const windowTitleFor = Msgs.def((serverId: string) => ({ text: () => `Sandbox: ${serverId}` }))

export const unavailable = Msgs.def(() => ({ text: () => 'This server is no longer an available sandbox.' }))

export const blurb = Msgs.def(() => ({
	text: () => 'This server is emulated. Players here are fabricated and nothing said or done reaches anyone real.',
}))

export const playersSection = Msgs.def(() => ({ text: () => 'Players' }))

export const bulkJoinCountPlaceholder = Msgs.def(() => ({ text: () => '10' }))

export const bulkJoin = Msgs.def(() => ({ text: () => 'Bulk join' }))

export const serverFull = Msgs.def((maxPlayers: number) => ({ text: () => `Full (${maxPlayers} players)` }))

export const join = Msgs.def(() => ({ text: () => 'Join' }))

export const matchSection = Msgs.def(() => ({ text: () => 'Match' }))

export const endMatch = Msgs.def(() => ({ text: () => 'End match' }))

export const teamWins = Msgs.def((teamId: 1 | 2) => ({ text: () => `Team ${teamId} wins` }))

export const dropRcon = Msgs.def(() => ({ text: () => 'Drop RCON' }))

export const adminListSection = Msgs.def(() => ({ text: () => 'Admin list' }))

export const popOut = Msgs.def(() => ({ text: () => 'Pop out' }))

export const consoleSection = Msgs.def(() => ({ text: () => 'Server console' }))

export const nobodyConnected = Msgs.def(() => ({ text: () => 'Nobody connected.' }))

export const searchPlayers = Msgs.def(() => ({ text: () => 'Search players' }))

export const searchPlayersLabel = Msgs.def(() => ({ text: () => 'Search players by name' }))

export const noPlayerMatches = Msgs.def(() => ({ text: () => 'No player matches that name.' }))

export const playerColumn = Msgs.def(() => ({ text: () => 'Player' }))

export const teamColumn = Msgs.def(() => ({ text: () => 'Team' }))

export const squadColumn = Msgs.def(() => ({ text: () => 'Squad' }))

export const adminColumn = Msgs.def(() => ({ text: () => 'Admin' }))

export const groupsColumn = Msgs.def(() => ({ text: () => 'Groups' }))

export const isAdminCheckbox = Msgs.def((playerName: string) => ({ text: () => `${playerName} is an admin` }))

export const groupPicker = Msgs.def(() => ({ text: () => 'Group' }))

export const noGroups = Msgs.def(() => ({ text: () => 'None' }))

export const disconnectPlayer = Msgs.def((playerName: string) => ({ text: () => `Disconnect ${playerName}` }))

export const previousPage = Msgs.def(() => ({ text: () => 'Previous page' }))

export const nextPage = Msgs.def(() => ({ text: () => 'Next page' }))

export const saySection = Msgs.def(() => ({ text: () => 'Say' }))

export const speakerPlaceholder = Msgs.def(() => ({ text: () => 'as...' }))

export const messagePlaceholder = Msgs.def(() => ({ text: () => '!vote 1' }))

export const send = Msgs.def(() => ({ text: () => 'Send' }))

export const adminChatNeedsAdmin = Msgs.def(() => ({
	text: () => 'Admin chat needs an admin. Tick Admin next to a player above.',
}))

export const adminsCfgTitle = Msgs.def((serverId: string) => ({ text: () => `Admins.cfg: ${serverId}` }))

export const adminListEmpty = Msgs.def(() => ({ text: () => 'The emulated admin list is empty.' }))
