import * as Msgs from '@/messages/shared'
import type * as SC from '@/models/server-console.models'

export const windowTitle = Msgs.def((serverId: string) => ({ text: () => `Server console: ${serverId}` }))

export const tabNames: Record<SC.Tab, string> = {
	unified: 'All',
	rcon: 'RCON',
	log: 'Logs',
	command: 'Player Commands',
}

export const channelTablist = Msgs.def(() => ({ text: () => 'Console channel' }))

export const tabOutput = Msgs.def((tab: SC.Tab) => ({ text: () => `${tabNames[tab]} console output` }))

export const hideNoise = Msgs.def(() => ({ text: () => 'Hide noise' }))

export const clear = Msgs.def(() => ({ text: () => 'Clear' }))

export const empty = Msgs.def(() => ({ text: () => 'Nothing yet.' }))

export const denied = Msgs.def(() => ({ text: () => "You do not have permission to read this server's console." }))
