import * as Msgs from '@/messages/shared'
import type * as SC from '@/models/server-console.models'

export const windowTitle = Msgs.def('Server console: {serverId}', (serverId: string) => ({ serverId }))

export const tabNames: Record<SC.Tab, string> = {
	unified: 'All',
	rcon: 'RCON',
	log: 'Logs',
	command: 'Player Commands',
}

export const channelTablist = Msgs.def('Console channel')

export const tabOutput = Msgs.def('{tab} console output', (tab: SC.Tab) => ({ tab: tabNames[tab] }))

export const hideNoise = Msgs.def('Hide noise')

export const clear = Msgs.def('Clear')

export const empty = Msgs.def('Nothing yet.')

export const denied = Msgs.def("You do not have permission to read this server's console.")
