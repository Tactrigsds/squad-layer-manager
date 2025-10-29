import { toAsyncGenerator, withAbortSignal } from '@/lib/async.ts'
import * as Obj from '@/lib/object'
import * as SS from '@/models/server-state.models'
import * as RBAC from '@/rbac.models.ts'
import * as DB from '@/server/db.ts'
import orpcBase from '@/server/orpc-base'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as Rbac from '@/server/systems/rbac.system'
import * as SquadServer from '@/server/systems/squad-server.ts'
import * as Orpc from '@orpc/server'
import * as Rx from 'rxjs'
import { z } from 'zod'

export const orpcRouter = {
	watchSettings: orpcBase.handler(async function*({ context: _ctx, signal }) {
		const obs = SquadServer.selectedServerCtx$(_ctx)
			.pipe(
				Rx.switchMap(async function*(ctx) {
					const state = await LayerQueue.getServerState(ctx)
					const settings = SS.getPublicSettings(state.settings)
					yield settings

					const settingsDelta$ = ctx.layerQueue.update$.pipe(
						Rx.map(([update]) => SS.getPublicSettings(update.state.settings)),
						Rx.startWith(settings),
						Rx.pairwise(),
					)
					for await (const [prevSettings, settings] of toAsyncGenerator(settingsDelta$)) {
						if (Obj.deepEqual(settings, prevSettings)) continue
						yield settings
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
				const state = await LayerQueue.getServerState(ctx)
				SS.applySettingMutations(state.settings, input)
				const res = SS.ServerSettingsSchema.safeParse(state.settings)
				if (!res.success) {
					return { code: 'err:invalid-settings' as const, message: res.error.message }
				}

				await LayerQueue.updateServerState(ctx, { settings: state.settings }, {
					type: 'manual',
					user: { discordId: ctx.user.discordId },
					event: 'edit',
				})
			})
		}),
}
