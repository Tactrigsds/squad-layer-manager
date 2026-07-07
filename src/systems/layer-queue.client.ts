import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { distinctDeepEquals } from '@/lib/async'
import * as ZusUtils from '@/lib/zustand'
import type * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as ZusRx from 'zustand-rx'

export const [useUnexpectedNextLayer, unexpectedNextLayer$] = ReactRx.bind(
	(serverId: string) => RPC.observe(() => RPC.orpc.layerQueue.watchUnexpectedNextLayer.call({ serverId })),
	null as L.LayerId | null,
)

// serverId === '' is used as a sentinel by consumers (e.g. LayerDisplay) rendered outside any squadServer frame context
export const [useLayerItemsState, layerItemsState$] = ReactRx.bind(
	(serverId: string) => {
		if (!serverId) return Rx.of({ layerItems: [], firstLayerItemParity: 0 } satisfies LQY.LayerItemsState)
		const key = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverId))
		return Rx.combineLatest([
			ZusRx.toStream(ZusUtils.resolveReadStore(key)).pipe(Rx.map(s => s.queue.layerList), Rx.distinctUntilChanged()),
			MatchHistoryClient.recentMatches$(serverId),
		]).pipe(
			Rx.map(([layerList, history]) => {
				return LQY.resolveLayerItemsState(layerList, history)
			}),
			distinctDeepEquals(),
		)
	},
)

export function watchServer(serverId: string, sub: Rx.Subscription) {
	sub.add(unexpectedNextLayer$(serverId).subscribe())
	sub.add(layerItemsState$(serverId).subscribe())
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
