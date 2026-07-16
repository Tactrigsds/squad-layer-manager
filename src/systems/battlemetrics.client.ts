import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import * as PG from '@/models/player-groupings.models'
import * as RPC from '@/orpc.client'
import * as SettingsClient from '@/systems/settings.client'
import * as ReactRx from '@react-rxjs/core'
import { useQuery } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

export const Store = Zus.createStore<BM.StoreState>(() => ({
	selectedGroupingId: null,
	slsOnly: false,
	orgFlags: [],
}))

export namespace Sel {
	// resolves the active grouping: the selected one if still configured, else the first configured
	export const activeGroupingId = (groupingIds: string[]) => (state: BM.StoreState) =>
		state.selectedGroupingId !== null && groupingIds.includes(state.selectedGroupingId)
			? state.selectedGroupingId
			: groupingIds[0] ?? null
}

export namespace Actions {
	export function setSelectedGroupingId(id: string | null) {
		Store.setState({ selectedGroupingId: id })
	}
	export function setSlsOnly(v: boolean) {
		Store.setState({ slsOnly: v })
	}
}

export const [usePlayerBmData, playerBmData$] = ReactRx.bind<BM.PublicPlayerBmData>(
	RPC.observe('battlemetrics.watchPlayerBmData', () => RPC.orpc.battlemetrics.watchPlayerBmData.call()).pipe(
		Rx.scan((acc, update) => ({ ...acc, [update.playerId]: update.data }), {} as BM.PublicPlayerBmData),
	),
	{},
)

export function useOrgFlags(): BM.PlayerFlag[] | undefined {
	const { data } = useQuery(RPC.orpc.battlemetrics.listOrgFlags.queryOptions({ staleTime: Infinity }))
	return data ?? undefined
}

export function usePlayerFlagIds(playerId: string): string[] | null {
	const bmData = usePlayerBmData()
	const player = bmData[playerId]
	return player?.flagIds ?? null
}

export function usePlayerFlags(playerId: string): BM.PlayerFlag[] | null {
	const flagIds = usePlayerFlagIds(playerId)
	const orgFlags = useOrgFlags()
	if (flagIds === null || !orgFlags) return null
	return BM.resolveFlags(flagIds, orgFlags)
}

export function usePlayerProfile(playerId: string) {
	const bmData = usePlayerBmData()
	const player = bmData[playerId]
	if (!player) return null
	const { flagIds: _, ...profile } = player
	return profile
}

// the color of the group this player falls into under the active grouping, or null when nothing matches
export function usePlayerGroupColor(playerId: string): string | null {
	const flags = usePlayerFlags(playerId)
	const orgFlags = useOrgFlags()
	const config = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const playerGroupings = config?.playerGroupings
	const groupingIds = playerGroupings ? PG.getGroupingIds(playerGroupings) : []
	const activeGroupingId = ZusUtils.useStore(Store, Sel.activeGroupingId(groupingIds))

	if (!flags || flags.length === 0 || !playerGroupings || activeGroupingId === null) return null
	const grouping = playerGroupings[activeGroupingId]
	if (!grouping) return null
	const group = PG.resolveGroup(grouping, flags)
	return group === undefined ? null : PG.getGroupColor(grouping, group, orgFlags)
}

export function setup() {
	playerBmData$.subscribe()

	RPC.observe('battlemetrics.watchPlayerBmData', () => RPC.orpc.battlemetrics.watchPlayerBmData.call()).subscribe((update) => {
		RPC.queryClient.setQueryData(
			RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId: update.playerId }, staleTime: Infinity }).queryKey,
			update.data,
		)
	})

	void (async () => {
		const orgFlagsRes = await RPC.queryClient.fetchQuery(RPC.orpc.battlemetrics.listOrgFlags.queryOptions({ staleTime: Infinity }))
		Store.setState({ orgFlags: orgFlagsRes ?? [] })
	})()
}
