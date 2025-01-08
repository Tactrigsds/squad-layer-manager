import * as M from '@/models'
import React from 'react'
import { BehaviorSubject, Observable, share } from 'rxjs'
import { trpc } from '@/lib/trpc.client'
import { useSubscription } from 'react-query-subscription'

const lqServerStateUpdateCold$ = new Observable<M.LQServerStateUpdate>((s) => {
	const sub = trpc.layerQueue.watchLayerQueueState.subscribe(undefined, {
		onData: (update) => s.next(update),
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
}).pipe(share())

export const lqServerStateUpdate$ = new BehaviorSubject<M.LQServerStateUpdate | null>(null)

export function useSetupLQStateUpdates() {
	React.useEffect(() => {
		lqServerStateUpdateCold$.subscribe(lqServerStateUpdate$)
	}, [])
}

export function useLQStateUpdates() {
	return useSubscription('lqStateUpdates', () => lqServerStateUpdateCold$, {})
}
