import { toAsyncGenerator, withAbortSignal } from '@/lib/async.ts'
import * as Obj from '@/lib/object'
import * as SS from '@/models/server-state.models'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models.ts'
import * as DB from '@/server/db.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Orpc from '@orpc/server'
import * as Rx from 'rxjs'
import { z } from 'zod'

const module = initModule('server-settings')
const orpcBase = getOrpcBase(module)

export const orpcRouter = {
	watchSettings: orpcBase.handler(async function*({ context: _ctx, signal }) {
		const obs: Rx.Observable<Readonly<[SS.PublicServerSettings, SS.LQStateUpdate['source'] | null]>> = SquadServer.selectedServerCtx$(_ctx)
			.pipe(
				Rx.switchMap(async function*(ctx) {
					const state = await SquadServer.getServerState(ctx)
					const settings = SS.getPublicSettings(state.settings)
					yield [settings, null] as const

					const settingsDelta$ = ctx.layerQueue.update$.pipe(
						Rx.map(([update]) => [SS.getPublicSettings(update.state.settings), update.source as SS.LQStateUpdate['source']] as const),
						Rx.startWith([settings, null] as const),
						Rx.pairwise(),
					)
					for await (const [[prevSettings], [settings, event]] of toAsyncGenerator(settingsDelta$)) {
						if (Obj.deepEqual(settings, prevSettings)) continue
						yield [settings, event] as const
					}
				}),
				withAbortSignal(signal!),
			)

		return yield* toAsyncGenerator(obs)
	}),

	updateSettings: orpcBase
		.input(z.array(SS.SettingMutationSchema))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('settings:write'))
			if (denyRes) return denyRes
			for (const mut of input) {
				if (mut.path[0] === 'connections') {
					throw new Orpc.ORPCError('FORBIDDEN', { message: 'err:trying-to-edit-connection-settings' })
				}
			}
			return await DB.runTransaction(ctx, async (ctx) => {
				const state = await SquadServer.getServerState(ctx)
				SS.applySettingMutations(state.settings, input)
				const res = SS.ServerSettingsSchema.safeParse(state.settings)
				if (!res.success) {
					return { code: 'err:invalid-settings' as const, message: res.error.message }
				}

				await SquadServer.updateServerState(ctx, { settings: state.settings }, {
					type: 'manual',
					user: USR.toMiniUser(ctx.user),
					event: 'edit-settings',
				})
			})
		}),
}
