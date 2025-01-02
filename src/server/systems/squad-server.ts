import { AsyncResource, toAsyncGenerator } from '@/lib/async'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import Rcon from '@/lib/rcon/rcon-core'
import * as SM from '@/lib/rcon/squad-models'
import SquadRcon from '@/lib/rcon/squad-rcon'
import * as C from '@/server/context.ts'

import { ENV } from '../env'
import { baseLogger } from '@/server/logger'
import { procedure, router } from '../trpc'
import { CONFIG } from '@/server/config'

export let rcon!: SquadRcon
export let adminList!: AsyncResource<SM.SquadAdmins>

export async function warnAllAdmins(ctx: C.Log, message: string) {
	await using opCtx = C.pushOperation(ctx, 'squad-server:warn-all-admins')
	const [{ value: admins }, { value: players }] = await Promise.all([adminList.get(opCtx), rcon.playerList.get(opCtx)])
	const ops: Promise<void>[] = []

	for (const player of players) {
		if (admins.has(player.steamID)) {
			ops.push(rcon.warn(opCtx, player.steamID.toString(), message))
			break
		}
	}
	await Promise.all(ops)
}

async function* watchServerStatus({ ctx }: { ctx: C.Log }) {
	using opCtx = C.pushOperation(ctx, 'squad-server:watch-status')
	for await (const info of toAsyncGenerator(rcon.serverStatus.observe(opCtx, { ttl: 3000 }))) {
		ctx.log.info(info, 'server status')
		yield info
	}
}

export async function setupSquadServer() {
	const adminListTTL = 1000 * 60 * 60
	const baseCtx = { log: baseLogger }

	await using opCtx = C.pushOperation(baseCtx, 'squad-server:setup', {
		level: 'info',
	})
	adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })
	void adminList.get(opCtx)

	const coreRcon = new Rcon({
		host: ENV.RCON_HOST,
		port: ENV.RCON_PORT,
		password: ENV.RCON_PASSWORD,
	})
	await coreRcon.connect(opCtx)
	rcon = new SquadRcon(baseCtx, coreRcon)
}

export const squadServerRouter = router({
	watchServerStatus: procedure.subscription(watchServerStatus),
})
