import * as M from '@/models'
import * as PartsSys from '@/systems.client/parts'
import { trpc } from '@/trpc.client'
import { bind } from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import * as Rx from 'rxjs'

export const userPresenceUpdate$ = new Rx.Observable<M.UserPresenceStateUpdate>((s) => {
	const sub = trpc.layerQueue.watchUserPresence.subscribe(undefined, {
		onData: (event) => {
			switch (event.code) {
				case 'update':
					PartsSys.stripParts(event.update)
					s.next(event.update)
					setUserPresence(event.update.state)
					break
				case 'initial-state':
					PartsSys.stripParts(event)
					setUserPresence(event.state)
					break
				default:
					event satisfies never
			}
		},
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
}).pipe(Rx.share())
userPresenceUpdate$.subscribe()

const [userPresenceChange$, setUserPresence] = createSignal<M.UserPresenceState | null>()
export const [useUserPresenceState, userPresenceState$] = bind<M.UserPresenceState | null>(userPresenceChange$, null)
