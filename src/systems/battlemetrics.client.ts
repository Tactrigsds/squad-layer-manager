import * as BM from '@/models/battlemetrics.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import * as ReactRx from '@react-rxjs/core'
import { useQuery } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

type StoreState = {
	selectedModeId: string | null
	setSelectedModeId: (id: string | null) => void
}

export const Store = Zus.createStore<StoreState>((set) => ({
	selectedModeId: null,
	setSelectedModeId: (id) => set({ selectedModeId: id }),
}))

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

export function useGroupedPlayerFlagColor(playerId: string): string | null {
	const flags = usePlayerFlags(playerId)
	const orgFlags = useOrgFlags()
	const config = ConfigClient.useConfig()
	const selectedModeId = Zus.useStore(Store, s => s.selectedModeId)

	if (!flags || flags.length === 0) return null

	const playerFlagGroupings = config?.playerFlagGroupings
	if (playerFlagGroupings && orgFlags) {
		const modeIds = BM.getGroupingModeIds(playerFlagGroupings)
		const activeModeId = selectedModeId !== null && modeIds.includes(selectedModeId)
			? selectedModeId
			: modeIds[0] ?? null

		if (activeModeId !== null) {
			const modeGroupings = playerFlagGroupings.filter(g => g.modeIds.includes(activeModeId))

			const flagColorById = new Map<string, string>()
			for (const flag of orgFlags) {
				if (flag.color) flagColorById.set(flag.id, flag.color)
			}

			const associations: [string, string, number][] = []
			for (const group of modeGroupings) {
				for (const [flagId, priority] of Object.entries(group.associations)) {
					associations.push([group.color, flagId, priority])
				}
			}
			associations.sort((a, b) => a[2] - b[2])
			for (const [groupColor, flagId] of associations) {
				if (flags.some(f => f.id === flagId)) {
					return flagColorById.get(groupColor) ?? groupColor
				}
			}
			return null
		}
	}

	// Fallback: hierarchy-based color
	return sortFlagsByHierarchy(flags)[0]?.color ?? null
}

export function setup() {
	playerBmData$.subscribe()
	RPC.observe(() => RPC.orpc.battlemetrics.watchPlayerBmData.call()).subscribe((update) => {
		RPC.queryClient.setQueryData(
			RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId: update.playerId }, staleTime: Infinity }).queryKey,
			update.data,
		)
	})
}
