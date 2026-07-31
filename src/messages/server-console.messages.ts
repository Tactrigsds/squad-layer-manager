import { def, t, type TString } from '@/models/messages.models'
import type * as SC from '@/models/server-console.models'

export const windowTitle = def('Server console: {serverId}', (serverId: string) => ({ serverId }))

export const tabNames: Record<SC.Tab, TString> = {
	unified: t('All'),
	rcon: t('RCON'),
	log: t('Logs'),
	command: t('Player Commands'),
	slm: t('Connection'),
}

export const channelTablist = def('Console channel')

export const tabOutput = def('{tab} console output', (tab: SC.Tab) => ({ tab: tabNames[tab] }))

export const hideNoise = def('Hide noise')

export const clear = def('Clear')

export const empty = def('Nothing yet.')

export const denied = def("You do not have permission to read this server's console.")
