import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client'

const w = window as any

w.SSClient = ServerSettingsClient
w.SSClient = ServerSettingsClient
w.SLLClient = SLLClient

console.log('-------- DEVELOPER CONSOLE LOADED --------')
