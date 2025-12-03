import * as LQClient from '@/systems.client/layer-queries.client'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as Im from 'immer'

const w = window as any

w.SSClient = ServerSettingsClient
w.SSClient = ServerSettingsClient
w.SLLClient = SLLClient
w.LQClient = LQClient
w.SquadClient = SquadServerClient
w.ChatStore = SquadServerClient.ChatStore
w.Im = Im

console.log('-------- DEVELOPER CONSOLE LOADED --------')
