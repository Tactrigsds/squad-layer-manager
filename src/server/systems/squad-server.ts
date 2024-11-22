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
let mockServer:


export async function setNextLayer(ctx: C.Log, layer: M.MiniLayer) {
	await using opCtx = C.pushOperation(ctx, 'squad-server:set-next-layer')
	await squadRcon.setNextLayer(opCtx, layer)
	nextLayer.invalidate(opCtx)
}

export async function warn(ctx: C.Log, anyId: string, message: string) {
	await using opCtx = C.pushOperation(ctx, 'squad-server:warn')
	return squadRcon.warn(opCtx, anyId, message)
}

export async function warnAllAdmins(ctx: C.Log, message: string) {
	await using opCtx = C.pushOperation(ctx, 'squad-server:warn-all-admins')
	const [{ value: admins }, { value: players }] = await Promise.all([adminList.get(opCtx), playerList.get(opCtx)])
	const ops: Promise<void>[] = []
	for (const player of players) {
		if (admins.has(player.steamID)) {
			ops.push(warn(opCtx, player.steamID.toString(), message))
			break
		}
	}
	await Promise.all(ops)
}

export async function broadcast(ctx: C.Log, message: string) {
	await using opCtx = C.pushOperation(ctx, 'squad-server:broadcast')
	return await squadRcon.broadcast(opCtx, message)
}

export function endGame(ctx: C.Log) {
	using opCtx = C.pushOperation(ctx, 'squad-server:end-game')
	return squadRcon.endGame(opCtx)
}

async function* watchServerStatus({ ctx }: { ctx: C.Log }) {
	using opCtx = C.pushOperation(ctx, 'squad-server:watch-status')
	for await (const info of toAsyncGenerator(serverStatus.observe(opCtx))) {
		yield info
	}
}

export async function setupSquadServer() {
	const log = baseLogger
	const baseCtx = { log }
	await using opCtx = C.pushOperation(baseCtx, 'squad-server:setup')
	rcon = new Rcon({ host: ENV.RCON_HOST, port: ENV.RCON_PORT, password: ENV.RCON_PASSWORD })
	const adminListTTL = 1000 * 60 * 60
	adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })
	// initialize cache
	adminList.get(opCtx)
	setInterval(() => {
		adminList.get(opCtx, { ttl: 0 })
	}, adminListTTL)

	await rcon.connect(opCtx)
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
