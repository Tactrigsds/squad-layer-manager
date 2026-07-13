import * as ChatPrt from '@/frame-partials/chat.partial'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import * as TeamswapsPrt from '@/frame-partials/teamswaps.partial'
import type * as FRM from '@/lib/frame'
import * as ZusUtils from '@/lib/zustand'

import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SETTINGS from '@/models/settings.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as VoteClient from '@/systems/vote.client'
import * as Rx from 'rxjs'

import { frameManager } from './frame-manager'

export type Input = { serverId: string }

export type State = ChatPrt.Store & ServerSettingsPrt.Store & LayerQueuePrt.Store & TeamswapsPrt.Store & {
	layerItemsState: LQY.LayerItemsState
	layerItemStatuses: LQY.LayerItemStatuses | null
}
export type Types = {
	name: 'squadServer'
	key: FRM.RawInstanceKey<{ serverId: string }>
	input: Input
	state: State
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>

export function createInput(serverId: string): Input {
	return { serverId }
}

export const frame = frameManager.createFrame<Types>({
	name: 'squadServer',
	createKey: (frameId, input) => ({ frameId, serverId: input.serverId }),
	setup(args) {
		ChatPrt.initChat(args)
		ServerSettingsPrt.initServerSettings(args)
		LayerQueuePrt.initLayerQueue(args)
		TeamswapsPrt.initTeamswaps(args)

		// keeps the read-only, per-server oRPC streams (serverInfo/serverRolling/layersStatus, vote state,
		// match history, unexpected-next-layer) hot for the lifetime of this frame instance
		SquadServerClient.watchServer(args.input.serverId, args.sub)
		VoteClient.watchServer(args.input.serverId, args.sub)
		MatchHistoryClient.watchServer(args.input.serverId, args.sub)
		LayerQueueClient.watchServer(args.input.serverId, args.sub)
		args.set({
			layerItemsState: LQY.initLayerItemsState(),
			layerItemStatuses: null,
		})

		Rx.combineLatest([
			args.update$.pipe(
				Rx.concatMap(([state, prev]): LL.List[] =>
					state.queue.layerList === prev.queue.layerList
						? []
						: [state.queue.layerList]
				),
			),
			MatchHistoryClient.recentMatches$(args.input.serverId),
		])
			.subscribe(([layerList, recentMatches]) => {
				args.set({
					layerItemsState: LQY.resolveLayerItemsState(layerList, recentMatches),
				})
			})

		const state$ = ZusUtils.toObservable(args.key, true)
		args.sub.add(
			Rx.combineLatest([
				state$.pipe(Rx.map(([state]) => state.layerItemsState), Rx.distinctUntilChanged()),
				state$.pipe(Rx.map(([state]) => state.settings.saved), Rx.distinctUntilChanged()),
				// filter edits invalidate previously computed statuses
				ZusUtils.toObservable(LayerQueriesClient.Store, true).pipe(
					Rx.map(([state]) => state.backgroundStateEpoch),
					Rx.distinctUntilChanged(),
				),
			]).pipe(
				Rx.debounceTime(250),
				Rx.switchMap(([list, settings]) =>
					Rx.from(LayerQueriesClient.fetchLayerItemStatuses({
						constraints: SETTINGS.getSettingsConstraints(settings),
						list,
					})).pipe(Rx.catchError(() => Rx.EMPTY))
				),
			).subscribe((layerItemStatuses) => {
				if (layerItemStatuses) args.set({ layerItemStatuses })
			}),
		)
	},
})

export function getLayerItemState$(squadServer: Key) {
	const list$ = ZusUtils.toObservable(squadServer, true).pipe(Rx.map(([state]) => state.queue.layerList), Rx.distinctUntilChanged())
	const history$ = MatchHistoryClient.recentMatches$(squadServer.serverId)
	return Rx.combineLatest([list$, history$]).pipe(Rx.map(([list, history]) => LQY.resolveLayerItemsState(list, history)))
}

export namespace Sel {
	export function settings(s: State) {
		return s.settings.saved
	}
	export function settingsOrDefault(s: State | undefined) {
		return s?.settings.saved ?? SETTINGS.PublicServerSettingsSchema.parse({})
	}
}
