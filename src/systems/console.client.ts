import * as LQClient from '@/systems/layer-queries.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as Im from 'immer'
import { z } from 'zod'

const w = window as any

w.SSClient = ServerSettingsClient
w.SSClient = ServerSettingsClient
w.SLLClient = SLLClient
w.LQClient = LQClient
w.SquadClient = SquadServerClient
w.ChatStore = SquadServerClient.ChatStore
w.Im = Im
w.z = z

console.log('-------- DEVELOPER CONSOLE LOADED --------')
