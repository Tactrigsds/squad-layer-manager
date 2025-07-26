import * as L from '@/models/layer'
import * as SS from '@/models/server-state.models'
import * as PartSys from '@/systems.client/parts'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { Observable } from 'rxjs'

const lqServerStateUpdateCold$ = new Observable<SS.LQServerStateUpdate>((s) => {
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

export const [useLqServerStateUpdate, lqServerStateUpdate$] = ReactRx.bind<SS.LQServerStateUpdate>(
	lqServerStateUpdateCold$ as Observable<SS.LQServerStateUpdate>,
)

const unexpectedNextLayerCold$ = new Observable<L.LayerId | null>((s) => {
	const sub = trpc.layerQueue.watchUnexpectedNextLayer.subscribe(undefined, {
		onData: (update) => {
			return s.next(update)
		},
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
})

export const [useUnexpectedNextLayer, unexpectedNextLayer$] = ReactRx.bind<L.LayerId | null>(
	unexpectedNextLayerCold$ as Observable<L.LayerId | null>,
	null,
)
