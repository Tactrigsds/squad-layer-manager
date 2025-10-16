import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as SS from '@/models/server-state.models'
import * as SLL from '@/models/shared-layer-list'
import * as C from '@/server/context'
import * as SquadServer from '@/server/systems/squad-server'
import * as TrpcServer from '@/server/trpc.server'
import * as Rx from 'rxjs'

const update$ = new Rx.Subject<[string, SLL.Update]>()

export function setup(serverState: SS.LQServerState): SharedLayerListContext {
	return {
		editSession: {
			layerQueueSeqId: serverState.layerQueueSeqId,
			list: serverState.layerQueue,
			ops: [],
			presence: new Map(),
		},
	}
}

export type SharedLayerListContext = {
	editSession: SLL.EditSession
}

export const router = TrpcServer.router({
	watchUpdates: TrpcServer.procedure.subscription(async function*({ ctx, signal }) {
		const updateForServer$ = SquadServer.selectedServerCtx$(ctx).pipe(
			Rx.switchMap(ctx => {
				const initial: SLL.Update = { code: 'init', state: ctx.editSession }
				return update$.pipe(
					Rx.concatMap(([serverId, update]): Rx.Observable<SLL.Update> => {
						if (ctx.serverId !== serverId) return Rx.EMPTY
						return Rx.of(update)
					}),
					Rx.startWith(initial),
				)
			}),
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(updateForServer$)
	}),
})
