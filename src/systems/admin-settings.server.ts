import * as RBAC from '@/rbac.models'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import { z } from 'zod'

const module = initModule('admin-settings')
const orpcBase = getOrpcBase(module)

export const orpcRouter = {
	enableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await SquadServer.enableServer(input.serverId)
		}),

	disableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await SquadServer.disableServer(input.serverId)
		}),
}
