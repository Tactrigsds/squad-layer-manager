import { Subject } from 'rxjs'

import { AsyncResource, toAsyncGenerator } from '@/lib/async'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import Rcon from '@/lib/rcon/rcon-core'
import * as SM from '@/lib/rcon/squad-models'
import SquadRcon from '@/lib/rcon/squad-rcon'
import * as M from '@/models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'

import { ENV } from '../env'
import { baseLogger } from '../logger'
import { procedure, router } from '../trpc'

export let rcon!: Rcon
let squadRcon!: SquadRcon

export let serverStatus: AsyncResource<SM.ServerStatus>
export let currentLayer: AsyncResource<M.MiniLayer>
export let nextLayer: AsyncResource<M.MiniLayer | null>
export let playerList: AsyncResource<SM.Player[]>
export let squadList: AsyncResource<SM.Squad[]>
export const squadEvent$ = new Subject<SM.SquadEvent>()
let adminList: AsyncResource<SM.SquadAdmins>

export async function setNextLayer(ctx: C.Log, layer: M.MiniLayer) {
	await squadRcon.setNextLayer(ctx, layer)
	nextLayer.invalidate(ctx)
}

export function warn(ctx: C.Log, anyId: string, message: string) {
	return squadRcon.warn(ctx, anyId, message)
}

export async function warnAllAdmins(ctx: C.Log, message: string) {
	const [{ value: admins }, { value: players }] = await Promise.all([adminList.get(ctx), playerList.get(ctx)])
	const ops: Promise<void>[] = []
	for (const player of players) {
		if (admins.has(player.steamID)) {
			ops.push(warn(ctx, player.steamID.toString(), message))
			break
		}
	}
	await Promise.all(ops)
}

export function broadcast(ctx: C.Log, message: string) {
	return squadRcon.broadcast(ctx, message)
}
export function endGame(ctx: C.Log) {
	return squadRcon.endGame(ctx)
}

async function* watchServerStatus({ ctx }: { ctx: C.Log }) {
	for await (const info of toAsyncGenerator(serverStatus.observe(ctx))) {
		yield info
	}
}

export async function setupSquadServer() {
	const log = baseLogger
	rcon = new Rcon({ host: ENV.RCON_HOST, port: ENV.RCON_PORT, password: ENV.RCON_PASSWORD })
	const adminListTTL = 1000 * 60 * 60
	adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })
	// initialize cache
	adminList.get({ log })
	setInterval(() => {
		adminList.get({ log }, { ttl: 0 })
	}, adminListTTL)

	await rcon.connect({ log })
	squadRcon = new SquadRcon(rcon)
	serverStatus = new AsyncResource('serverStatus', (ctx) => squadRcon.getServerStatus(ctx))
	currentLayer = new AsyncResource('currentLayer', (ctx) => squadRcon.getCurrentLayer(ctx))
	nextLayer = new AsyncResource('nextLayer', (ctx) => squadRcon.getNextLayer(ctx))
	playerList = new AsyncResource('playerList', (ctx) => squadRcon.getListPlayers(ctx))
	squadList = new AsyncResource('squadList', (ctx) => squadRcon.getSquads(ctx))
}

export const squadServerRouter = router({
	watchServerStatus: procedure.subscription(watchServerStatus),
})
