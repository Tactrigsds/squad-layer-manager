import * as M from '@/models'
import React from 'react'
import { BehaviorSubject, Observable, share, map, filter } from 'rxjs'
import { trpc } from '@/lib/trpc.client'
import { bind } from '@react-rxjs/core'
import * as PartSys from '@/systems.client/parts'

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
	null
)
