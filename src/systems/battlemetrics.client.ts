import type * as BM from '@/models/battlemetrics.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import { useQuery } from '@tanstack/react-query'

export const getPlayerFlagsQueryOptions = (steamId: string) =>
	RPC.orpc.battlemetrics.getPlayerFlags.queryOptions({
		input: { steamId },
		staleTime: Infinity,
	})

export const getPlayerProfileQueryOptions = (steamId: string) =>
	RPC.orpc.battlemetrics.getPlayerProfile.queryOptions({
		input: { steamId },
		staleTime: Infinity,
	})

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

export function usePlayerFlagColor(steamId: string): string | null {
	const { data: flags } = useQuery(getPlayerFlagsQueryOptions(steamId))
	if (!flags || flags.length === 0) return null
	return sortFlagsByHierarchy(flags)[0]?.color ?? null
}
