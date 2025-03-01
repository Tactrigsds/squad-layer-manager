import { trpc } from '@/lib/trpc.client'
import * as M from '@/models'
import * as PartSys from '@/systems.client/parts'
import { bind } from '@react-rxjs/core'
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

export const [useLqServerStateUpdate, lqServerStateUpdate$] = bind<M.LQServerStateUpdate | null>(
	lqServerStateUpdateCold$ as Observable<M.LQServerStateUpdate | null>,
	null,
)
