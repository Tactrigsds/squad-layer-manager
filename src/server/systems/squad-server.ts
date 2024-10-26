import { Observable } from 'rxjs'

import { AsyncResource, resolvePromises } from '@/lib/async'
import Rcon from '@/lib/rcon/rcon-core'
import * as Queries from '@/lib/rcon/rcon-squad-queries'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models.ts'
import * as C from '@/server/context'

import { ENV } from '../env'
import { baseLogger } from '../logger'

type QueryCtx = C.Log
export let rcon!: Rcon

export let serverStatus: AsyncResource<[QueryCtx], SM.ServerStatus>
export let currentLayer: AsyncResource<[QueryCtx], M.MiniLayer>
export let nextLayer: AsyncResource<[QueryCtx], M.MiniLayer | null>
export let playerList: AsyncResource<[QueryCtx], SM.Player[]>
export let squadList: AsyncResource<[QueryCtx], SM.Squad[]>

export async function setupSquadServer() {
	const log = baseLogger
	rcon = new Rcon({ host: ENV.DB_HOST, port: ENV.DB_PORT, password: ENV.DB_PASSWORD })
	const rconCtx = { rcon }
	serverStatus = new AsyncResource('serverStatus', (ctx) => Queries.getServerStatus({ ...ctx, ...rconCtx }))
	currentLayer = new AsyncResource('currentLayer', (ctx) => Queries.getCurrentLayer({ ...ctx, ...rconCtx }))
	nextLayer = new AsyncResource('nextLayer', (ctx) => Queries.getNextLayer({ ...ctx, ...rconCtx }))
	playerList = new AsyncResource('playerList', (ctx) => Queries.getListPlayers({ ...ctx, ...rconCtx }))
	squadList = new AsyncResource('squadList', (ctx) => Queries.getSquads({ ...ctx, ...rconCtx }))
	await rcon.connect({ log })
}
