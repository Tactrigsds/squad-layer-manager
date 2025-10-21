import { toAsyncGenerator, withAbortSignal } from '@/lib/async.ts'
import * as Obj from '@/lib/object'
import * as CS from '@/models/context-shared'
import * as SS from '@/models/server-state.models'
import * as RBAC from '@/rbac.models.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import * as FilterEntity from '@/server/systems/filter-entity.ts'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as Rbac from '@/server/systems/rbac.system'
import * as SquadServer from '@/server/systems/squad-server.ts'
import * as TrpcServer from '@/server/trpc.server'
import * as Otel from '@opentelemetry/api'
import { TRPCError } from '@trpc/server'
import * as Rx from 'rxjs'
import { z } from 'zod'

const tracer = Otel.trace.getTracer('server-settings')

export function init(ctx: C.ServerId & C.ServerSliceSub & CS.Log) {
	const serverId = ctx.serverId

	// -------- trim pool filters when filter entities are deleted --------
	ctx.serverSliceSub.add(
		FilterEntity.filterMutation$
			.pipe(
				Rx.filter(([_, mut]) => mut.type === 'delete'),
				C.durableSub('server-settings:handle-filter-delete', { ctx, tracer }, async ([_ctx, mutation]) => {
					const ctx = SquadServer.resolveSliceCtx(_ctx, serverId)
					await DB.runTransaction(ctx, async (ctx) => {
						const serverState = await LayerQueue.getServerState(ctx)
						const remainingFilterIds = serverState.settings.queue.mainPool.filters.filter(f => f !== mutation.key)
						if (remainingFilterIds.length === serverState.settings.queue.mainPool.filters.length) return null
						serverState.settings.queue.mainPool.filters = remainingFilterIds
						await LayerQueue.updateServerState(ctx, { settings: serverState.settings }, { type: 'system', event: 'filter-delete' })
					})
				}),
			).subscribe(),
	)
}

export const router = TrpcServer.router({
	watchSettings: TrpcServer.procedure.subscription(async function*({ ctx: _ctx, signal }) {
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

	updateSettings: TrpcServer.procedure.input(z.array(SS.SettingMutationSchema)).mutation(async ({ ctx: _ctx, input }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('settings:write'))
		if (denyRes) return denyRes
		for (const mut of input) {
			if (mut.path[0] === 'connections') {
				throw new TRPCError({ code: 'FORBIDDEN', message: 'err:trying-to-edit-connection-settings' })
			}
		}
		await DB.runTransaction(ctx, async (ctx) => {
			const state = await LayerQueue.getServerState(ctx)
			SS.applySettingMutations(state.settings, input)
			const res = SS.ServerSettingsSchema.safeParse(state.settings)
			if (!res.success) {
				throw new TRPCError({ code: 'BAD_REQUEST', message: 'err:invalid-settings', cause: res.error })
			}

			await LayerQueue.updateServerState(ctx, { settings: state.settings }, {
				type: 'manual',
				user: { discordId: ctx.user.discordId },
				event: 'edit',
			})
		})
	}),
})
