import { def, t, type TString } from '@/models/messages.models'
import type * as SC from '@/models/server-console.models'

export const windowTitle = def('Server console: {serverId}', (serverId: string) => ({ serverId }))

export const tabNames: Record<SC.ConsoleChannel, TString> = {
	rcon: t('RCON'),
	log: t('Logs'),
	command: t('Player Commands'),
	slm: t('Connection'),
}

export const channelTablist = def('Console channel')

export const tabOutput = def('{tab} console output', (tab: SC.ConsoleChannel) => ({ tab: tabNames[tab] }))

export const hideNoise = def('Hide noise')

export const showSlmRequests = def('Show SLM requests')

export const showSlmRequestsHint = def("Show the commands SLM sends to the server, and the server's responses to them.")

export const showEvents = def('Show events')

export const showEventsHint = def('Show the messages the server sends without being asked, such as chat.')

export const commandInput = def('RCON command')

export const commandPlaceholder = def('Run an RCON command, such as ListPlayers')

export const run = def('Run')

export const commandDenied = def('You do not have permission to run commands on this server.')

export const clear = def('Clear')

export const empty = def('Nothing yet.')

export const denied = def("You do not have permission to read this server's console.")
