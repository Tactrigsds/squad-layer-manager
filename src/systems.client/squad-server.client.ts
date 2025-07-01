import type * as SM from '@/models/squad.models'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'

export const [useSquadServerStatus, squadServerStatus$] = ReactRx.bind<SM.ServerStatusWithCurrentMatchRes>(
	new Rx.Observable<SM.ServerStatusWithCurrentMatchRes>((s) => {
		const sub = trpc.squadServer.watchServerStatus.subscribe(undefined, {
			onData: (data) => {
				s.next(data)
			},
			onComplete: () => {
				s.complete()
			},
			onError: err => s.error(err),
		})
		return () => {
			return sub.unsubscribe()
		}
	}),
)

export function useEndMatch() {
	return useMutation({
		mutationFn: async () => {
			return trpc.squadServer.endMatch.mutate()
		},
	})
}

export function useDisableFogOfWarMutation() {
	return useMutation({
		mutationFn: async () => {
			return trpc.squadServer.toggleFogOfWar.mutate({ disabled: true })
		},
	})
}

export function setup() {
	squadServerStatus$.subscribe()
}
