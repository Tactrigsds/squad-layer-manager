import { Subject } from 'rxjs'

import { AsyncResource, toAsyncGenerator } from '@/lib/async'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import Rcon from '@/lib/rcon/rcon-core'
import * as SM from '@/lib/rcon/squad-models'
import SquadRcon from '@/lib/rcon/squad-rcon'
import * as M from '@/models.ts'
import * as C from '@/server/context.ts'

import { ENV } from '../env'
import { baseLogger } from '@/server/logger'
import { procedure, router } from '../trpc'
import { CONFIG } from '@/server/config'

export let rcon!: SquadRcon
export let adminList!: AsyncResource<SM.SquadAdmins>

async function* watchServerStatus({ ctx }: { ctx: C.Log }) {
	using opCtx = C.pushOperation(ctx, 'squad-server:watch-status')
	for await (const info of toAsyncGenerator(rcon.serverStatus.observe(opCtx))) {
		yield info
	}
}

export async function setupSquadServer() {
  const adminListTTL = 1000 * 60 * 60
  const baseCtx = { log: baseLogger }

	await using opCtx = C.pushOperation(baseCtx, 'squad-server:setup')
	adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })
  adminList.get(opCtx)

	const coreRcon = new Rcon({ host: ENV.RCON_HOST, port: ENV.RCON_PORT, password: ENV.RCON_PASSWORD })
	await coreRcon.connect(opCtx)
	rcon = new SquadRcon(baseCtx, coreRcon)
}

export const squadServerRouter = router({
	watchServerStatus: procedure.subscription(watchServerStatus),
})
