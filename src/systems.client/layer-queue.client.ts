import * as M from '@/models'
import * as PartSys from '@/systems.client/parts'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { Observable } from 'rxjs'

const lqServerStateUpdateCold$ = new Observable<M.LQServerStateUpdate>((s) => {
	const sub = trpc.layerQueue.watchLayerQueueState.subscribe(undefined, {
		onData: (update) => {
			PartSys.stripParts(update)
			return s.next(update)
		},
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
})

export const [useLqServerStateUpdate, lqServerStateUpdate$] = ReactRx.bind<M.LQServerStateUpdate | null>(
	lqServerStateUpdateCold$ as Observable<M.LQServerStateUpdate | null>,
	null,
)

const unexpectedNextLayerCold$ = new Observable<M.LayerId | null>((s) => {
	const sub = trpc.layerQueue.watchUnexpectedNextLayer.subscribe(undefined, {
		onData: (update) => {
			return s.next(update)
		},
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
})

export const [useUnexpectedNextLayer, unexpectedNextLayer$] = ReactRx.bind<M.LayerId | null>(
	unexpectedNextLayerCold$ as Observable<M.LayerId | null>,
	null,
)
