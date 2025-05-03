import type * as SM from '@/lib/rcon/squad-models.ts'
import * as M from '@/models.ts'
import * as Parts from '@/systems.client/parts'
import { trpc } from '@/trpc.client'
import { shareLatest, state } from '@react-rxjs/core'
import { useStateObservable } from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import React from 'react'
import * as Rx from 'rxjs'

export const squadServerStatus$ = state(
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

// cringe way of doing this,  but trpc-jotai is weird. should write my own at some point maybe tanstack query can handle this usecase as well idk
export function useSquadServerStatus() {
	return useStateObservable(squadServerStatus$)
}

export function useEndMatch() {
	return useMutation({
		mutationFn: async () => {
			return trpc.squadServer.endMatch.mutate()
		},
	})
}
