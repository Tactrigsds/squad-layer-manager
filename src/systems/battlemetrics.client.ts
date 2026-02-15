import type * as BM from '@/models/battlemetrics.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'

import * as ReactRx from '@react-rxjs/core'

import type { PublicPlayerBmData } from '@/models/battlemetrics.models'

export const [usePlayerBmData, playerBmData$] = ReactRx.bind<PublicPlayerBmData>(
	RPC.observe(() => RPC.orpc.battlemetrics.watchPlayerBmData.call()),
	{},
)

export const getPlayerBansAndNotesQueryOptions = (steamId: string) =>
	RPC.orpc.battlemetrics.getPlayerBansAndNotes.queryOptions({
		input: { steamId },
		staleTime: Infinity,
	})

export function sortFlagsByHierarchy<T extends BM.PlayerFlag>(flags: T[]): T[] {
	const hierarchy = ConfigClient.getConfig()?.playerFlagColorHierarchy
	if (!hierarchy || hierarchy.length === 0) return flags
	return [...flags].sort((a, b) => {
		const aIdx = hierarchy.indexOf(a.id)
		const bIdx = hierarchy.indexOf(b.id)
		return (aIdx === -1 ? Infinity : aIdx) - (bIdx === -1 ? Infinity : bIdx)
	})
}

export function usePlayerFlags(steamId: string) {
	const bmData = usePlayerBmData()
	const player = bmData[steamId]
	return player?.flags ?? null
}

export function usePlayerProfile(steamId: string) {
	const bmData = usePlayerBmData()
	const player = bmData[steamId]
	if (!player) return null
	const { flags: _, ...profile } = player
	return profile
}

export function usePlayerFlagColor(steamId: string): string | null {
	const flags = usePlayerFlags(steamId)
	if (!flags || flags.length === 0) return null
	return sortFlagsByHierarchy(flags)[0]?.color ?? null
}

export function setup() {
	playerBmData$.subscribe()
}
