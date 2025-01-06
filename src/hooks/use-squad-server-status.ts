import type * as Squad from '@/lib/rcon/squad-models'
import { trpc, trpcConnected$ } from '@/lib/trpc.client.ts'
import * as M from '@/models.ts'
import type * as SM from '@/lib/rcon/squad-models.ts'
import React from 'react'
import { firstValueFrom, Observable, share, filter, endWith, Subscription } from 'rxjs'
import { atom, getDefaultStore, useAtomValue } from 'jotai'

const serverStatusAtom = atom<SM.ServerStatus | null>(null)
const squadServerStatus$ = new Observable<SM.ServerStatus>(() => {
	const sub = new Subscription()
	;(async () => {
		const connected = await firstValueFrom(
			trpcConnected$.pipe(
				filter((connected) => !!connected),
				endWith(false)
			)
		)
		if (!connected || sub.closed) return
		sub.add(
			trpc.squadServer.watchServerStatus.subscribe(undefined, {
				onData: (data) => {
					getDefaultStore().set(serverStatusAtom, data)
				},
			})
		)
	})()
	return () => {
		return sub.unsubscribe()
	}
}).pipe(
	// calling share() effectively makes this subscription ref counted
	share()
)

// cringe way of doing this,  but trpc-jotai is weird. should write my own at some point maybe tanstack query can handle this usecase as well idk
export function useSquadServerStatus() {
	React.useEffect(() => {
		const sub = squadServerStatus$.subscribe()
		return () => sub.unsubscribe()
	}, [])
	return useAtomValue(serverStatusAtom, { store: getDefaultStore() })
}

export type FilterMutationHandle = {
	onUpdate?: (update: M.UserEntityMutation<M.FilterEntity>) => void
}
