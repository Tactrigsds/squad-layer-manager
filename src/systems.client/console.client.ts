import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'

const w = window as any

w.SSClient = ServerSettingsClient
w.SSClient = ServerSettingsClient
w.SLLClient = SLLClient
w.SquadClient = SquadServerClient
w.ChatStore = SquadServerClient.ChatStore

console.log('-------- DEVELOPER CONSOLE LOADED --------')
