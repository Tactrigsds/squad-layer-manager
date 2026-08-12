import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SRQPrt from '@/frame-partials/switch-requests.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as RSel from '@/lib/reselect'
import { toast } from '@/lib/toast'
import * as SRQ_Msgs from '@/messages/switch-requests.messages'
import * as SM from '@/models/squad.models'
import * as SRQ from '@/models/switch-requests.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'

export type Store = SRQPrt.Store

export namespace Sel {
	export function requests(store: Store) {
		return store.switchRequests.requests
	}

	export function requestCount(store: Store) {
		return store.switchRequests.requests.length
	}

	export function isQueued(playerId: SM.PlayerId): (store: Store) => boolean {
		return (store: Store) => !!SRQ.requestFor(store.switchRequests.requests, playerId)
	}

	export function isSwitching(playerId: SM.PlayerId): (store: Store) => boolean {
		return (store: Store) => store.switchRequests.swapping.includes(playerId)
	}

	export type EnrichedRequest = SRQ.SwitchRequest & { position: number; player: SM.Player | null; switching: boolean }

	// the window's rows for one direction, in queue order, with live player identity joined in
	export const queueForTeam = RSel.memoizeFactory((fromTeam: SM.TeamId) =>
		RSel.createSelector(
			[
				(s: Store & ChatPrt.Store) => s.switchRequests.requests,
				(s: Store & ChatPrt.Store) => s.switchRequests.swapping,
				(s: Store & ChatPrt.Store) => ChatPrt.Sel.chatState(s).players,
			],
			(requests, swapping, players): EnrichedRequest[] =>
				SRQ.queueFor(requests, fromTeam).map((request, index) => ({
					...request,
					position: index + 1,
					player: SM.PlayerIds.find(players, (p) => p.ids, request.playerId) ?? null,
					switching: swapping.includes(request.playerId),
				})),
		),
	)
}

export namespace Actions {
	export async function switchNow(stores: SquadServerFrame.KeyProp, playerId: SM.PlayerId) {
		const serverId = stores.squadServer!.serverId
		const res = await RPC.orpc.switchRequests.switchNow.call({ serverId, playerId })
		if (res && res.code !== 'ok') {
			toast.error(...tr.toast(SRQ_Msgs.switchNowFailed(res.code)))
		}
	}
}

// the queued players on a team, for the shift-click "select all requesters" action
export function switchRequesterIds(state: Store & ChatPrt.Store, teamId?: SM.TeamId): SM.PlayerId[] {
	const queued = new Set(state.switchRequests.requests.map((r) => r.playerId))
	return ChatPrt.Sel.chatState(state)
		.players.filter((p) => queued.has(SM.PlayerIds.getPlayerId(p.ids)) && (teamId == null || p.teamId === teamId))
		.map((p) => SM.PlayerIds.getPlayerId(p.ids))
}
