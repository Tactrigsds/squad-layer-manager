import { distinctDeepEquals } from '@/lib/async'
import * as DH from '@/lib/display-helpers'
import * as TrpcHelpers from '@/lib/trpc-helpers'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'

// TODO we probably don't need to "bind" multiple observables like this. we should create some helper "derive" which lets us derive one state observable from another
export const [useLayersStatus, layersStatus$] = ReactRx.bind<SM.LayersStatusResExt>(
	TrpcHelpers.fromTrpcSub(undefined, trpc.squadServer.watchLayersStatus.subscribe),
)
export const [useServerInfo, serverInfo$] = ReactRx.bind<SM.ServerInfoRes>(
	TrpcHelpers.fromTrpcSub(undefined, trpc.squadServer.watchServerInfo.subscribe),
)

export const [useCurrentMatch, currentMatch$] = ReactRx.bind<MH.MatchDetails | null>(
	layersStatus$.pipe(
		Rx.map(res => res.code === 'ok' && res.data.currentMatch ? res.data.currentMatch : null),
		distinctDeepEquals(),
	),
	null,
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
	layersStatus$.subscribe(status => {
		if (status.code !== 'ok') return
		console.log('layersStatus', {
			currentLayer: DH.displayUnvalidatedLayer(status.data.currentLayer),
			nextLayer: DH.displayUnvalidatedLayer(status.data.nextLayer!),
			currentMatch: status.data.currentMatch && DH.displayUnvalidatedLayer(status.data.currentMatch?.layerId),
		})
	})

	serverInfo$.subscribe()
	currentMatch$.subscribe()
}
