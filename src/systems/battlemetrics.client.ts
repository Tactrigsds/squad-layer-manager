import type * as BM from '@/models/battlemetrics.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import * as ReactRx from '@react-rxjs/core'
import { useQuery } from '@tanstack/react-query'
import * as Rx from 'rxjs'

export const [usePlayerBmData, playerBmData$] = ReactRx.bind<BM.PublicPlayerBmData>(
	RPC.observe(() => RPC.orpc.battlemetrics.watchPlayerBmData.call()).pipe(
		Rx.scan((acc, update) => ({ ...acc, [update.playerId]: update.data }), {} as BM.PublicPlayerBmData),
	),
	{},
)

export function useOrgFlags(): BM.PlayerFlag[] | undefined {
	const { data } = useQuery(RPC.orpc.battlemetrics.listOrgFlags.queryOptions())
	return data
}

export function sortFlagsByHierarchy<T extends BM.PlayerFlag>(flags: T[]): T[] {
	const hierarchy = ConfigClient.getConfig()?.playerFlagColorHierarchy
	if (!hierarchy || hierarchy.length === 0) return flags
	return [...flags].sort((a, b) => {
		const aIdx = hierarchy.indexOf(a.id)
		const bIdx = hierarchy.indexOf(b.id)
		return (aIdx === -1 ? Infinity : aIdx) - (bIdx === -1 ? Infinity : bIdx)
	})
}

export function resolveFlags(flagIds: string[], orgFlags: BM.PlayerFlag[]): BM.PlayerFlag[] {
	return flagIds.flatMap((id) => {
		const flag = orgFlags.find((f) => f.id === id)
		return flag ? [flag] : []
	})
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
	return resolveFlags(flagIds, orgFlags)
}

export function usePlayerProfile(playerId: string) {
	const bmData = usePlayerBmData()
	const player = bmData[playerId]
	if (!player) return null
	const { flagIds: _, ...profile } = player
	return profile
}

export function usePlayerFlagColor(playerId: string): string | null {
	const flags = usePlayerFlags(playerId)
	if (!flags || flags.length === 0) return null
	return sortFlagsByHierarchy(flags)[0]?.color ?? null
}

export function setup() {
	playerBmData$.subscribe()
	RPC.observe(() => RPC.orpc.battlemetrics.watchPlayerBmData.call()).subscribe((update) => {
		RPC.queryClient.setQueryData(
			RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId: update.playerId } }).queryKey,
			update.data,
		)
	})
}
