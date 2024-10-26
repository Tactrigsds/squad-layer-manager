import { Subject } from 'rxjs'

import { AsyncResource } from '@/lib/async'
import Rcon from '@/lib/rcon/rcon-core'
import * as SM from '@/lib/rcon/squad-models'
import SquadRcon from '@/lib/rcon/squad-rcon'
import * as M from '@/models.ts'
import * as C from '@/server/context'

import { ENV } from '../env'
import { baseLogger } from '../logger'

export let rcon!: Rcon
let squadRcon!: SquadRcon

export let serverStatus: AsyncResource<SM.ServerStatus>
export let currentLayer: AsyncResource<M.MiniLayer>
export let nextLayer: AsyncResource<M.MiniLayer | null>
export let playerList: AsyncResource<SM.Player[]>
export let squadList: AsyncResource<SM.Squad[]>
export const squadEvent$ = new Subject<SM.SquadEvent>()

export async function setNextLayer(ctx: C.Log, layer: M.MiniLayer) {
	await squadRcon.setNextLayer(ctx, layer)
	nextLayer.invalidate(ctx)
}

export function warn(ctx: C.Log, anyId: string, message: string) {
	return squadRcon.warn(ctx, anyId, message)
}
export function broadcast(ctx: C.Log, message: string) {
	return squadRcon.broadcast(ctx, message)
}
export function endGame(ctx: C.Log) {
	return squadRcon.endGame(ctx)
}

export async function setupSquadServer() {
	const log = baseLogger
	rcon = new Rcon({ host: ENV.RCON_HOST, port: ENV.RCON_PORT, password: ENV.RCON_PASSWORD })
	squadRcon = new SquadRcon(rcon)
	serverStatus = new AsyncResource('serverStatus', (ctx) => squadRcon.getServerStatus(ctx))
	currentLayer = new AsyncResource('currentLayer', (ctx) => squadRcon.getCurrentLayer(ctx))
	nextLayer = new AsyncResource('nextLayer', (ctx) => squadRcon.getNextLayer(ctx))
	playerList = new AsyncResource('playerList', (ctx) => squadRcon.getListPlayers(ctx))
	squadList = new AsyncResource('squadList', (ctx) => squadRcon.getSquads(ctx))
	await rcon.connect({ log })
}
