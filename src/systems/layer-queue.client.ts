import { useMutation } from '@tanstack/react-query'

import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as Cleanup from '@/lib/cleanup'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import type * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'

export const [useUnexpectedNextLayer, unexpectedNextLayer$] = ReactRx.bindWithDefault(
	(serverId: string) =>
		RPC.observe('layerQueue.watchUnexpectedNextLayer', () => RPC.orpc.layerQueue.watchUnexpectedNextLayer.call({ serverId })).pipe(
			RPC.dropServerNotLoaded(),
		),
	null as L.LayerId | null,
)

// serverId === '' is used as a sentinel by consumers (e.g. LayerDisplay) rendered outside any squadServer frame context
export const [useLayerItemsState, layerItemsState$] = ReactRx.bind('layerQueue.layerItemsState', (serverId: string) => {
	if (!serverId) return Rx.of({ layerItems: [], firstLayerItemParity: 0 } satisfies LQY.LayerItemsState)
	const key = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverId))
	return Rx.combineLatest([
		Zus.toStream(Zus.resolveReadStore(key), undefined, { fireImmediately: true }).pipe(
			Rx.map((s) => s.queue.layerList),
			Rx.distinctUntilChanged(),
		),
		MatchHistoryClient.recentMatches$(serverId),
	]).pipe(
		Rx.map(([layerList, history]) => {
			return LQY.resolveLayerItemsState(layerList, history)
		}),
		Rx.Ext.distinctDeepEquals(),
	)
})

export function watchServer(serverId: string, cleanup: Cleanup.Tasks) {
	cleanup.push(unexpectedNextLayer$(serverId).subscribe())
	cleanup.push(layerItemsState$(serverId).pipe(ReactRx.retryHot()).subscribe())
}

export function useToggleSquadServerUpdates(serverId: string) {
	const saveChangesMutation = useMutation(RPC.orpc.layerQueue.toggleUpdatesToSquadServer.mutationOptions())

	return {
		disableUpdates: () => {
			saveChangesMutation.mutate({ serverId, disabled: true })
		},
		enableUpdates: () => {
			saveChangesMutation.mutate({ serverId, disabled: false })
		},
	}
}
