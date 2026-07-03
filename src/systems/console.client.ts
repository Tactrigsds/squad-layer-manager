import * as RPC from '@/orpc.client'
import * as LQClient from '@/systems/layer-queries.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as UPClient from '@/systems/user-presence.client'

import * as Im from 'immer'
import { z } from 'zod'

const w = window as any

w.SSClient = SettingsClient
w.LQClient = LQClient
w.SquadClient = SquadServerClient
w.UPClient = UPClient
w.TsClient = TSWClient
w.Im = Im
w.z = z
w.RPC = RPC

console.log('-------- DEVELOPER CONSOLE LOADED --------')
