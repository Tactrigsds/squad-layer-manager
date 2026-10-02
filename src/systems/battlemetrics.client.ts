import { useMutation, useQuery } from '@tanstack/react-query'
import React from 'react'

import * as Obj from '@/lib/object-utils'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import * as PG from '@/models/player-groupings.models'
import * as RPC from '@/orpc.client'
import * as SettingsClient from '@/systems/settings.client'

export const Store = Zus.createStore<BM.StoreState>(() => ({
	selectedGroupingId: null,
	slsOnly: false,
	orgFlags: [],
}))

export namespace Sel {
	// resolves the active grouping: the selected one if still on offer, else the first on offer
	export const activeGroupingId = (groupingIds: string[]) => (state: BM.StoreState) =>
		state.selectedGroupingId !== null && groupingIds.includes(state.selectedGroupingId)
			? state.selectedGroupingId
			: (groupingIds[0] ?? null)
}

export namespace Actions {
	export function setSelectedGroupingId(id: string | null) {
		Store.setState({ selectedGroupingId: id })
	}
	export function setSlsOnly(v: boolean) {
		Store.setState({ slsOnly: v })
	}
}

// Every reader of the map recomputes when its identity changes, so a batch that changes no entry keeps the map, and an
// entry that comes back unchanged keeps its object. A changed entry also lands in the per-player query cache.
export const [usePlayerBmData, playerBmData$] = ReactRx.bindWithDefault<BM.PublicPlayerBmData>(
	RPC.observe('battlemetrics.watchPlayerBmData', () => RPC.orpc.battlemetrics.watchPlayerBmData.call()).pipe(
		RPC.dropUnavailable(),
		Rx.scan((acc, updates) => {
			let next: BM.PublicPlayerBmData | null = null
			for (const { playerId, data } of updates) {
				if (Obj.deepEqual((next ?? acc)[playerId], data)) continue
				next ??= { ...acc }
				next[playerId] = data
				RPC.queryClient.setQueryData(
					RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId }, staleTime: Infinity }).queryKey,
					data,
				)
			}
			return next ?? acc
		}, {} as BM.PublicPlayerBmData),
		Rx.distinctUntilChanged(),
	),
	{},
)

export function useOrgFlags(): BM.PlayerFlag[] | undefined {
	const { data } = useQuery(RPC.orpc.battlemetrics.listOrgFlags.queryOptions({ staleTime: Infinity }))
	return data ?? undefined
}

// busts the server's BM cache for these players and refetches; fresh data arrives over the watch stream
export function useRefreshPlayerBmData() {
	return useMutation(RPC.orpc.battlemetrics.refreshPlayerBmData.mutationOptions())
}

export function useMyToken() {
	return useQuery(RPC.orpc.battlemetrics.getMyToken.queryOptions())
}

function invalidateMyToken() {
	void RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.battlemetrics.getMyToken.key() })
}

export function useSetMyTokenMutation() {
	return useMutation(
		RPC.orpc.battlemetrics.setMyToken.mutationOptions({
			onSuccess: (res) => {
				if (res.code === 'ok') invalidateMyToken()
			},
		}),
	)
}

export function useRemoveMyTokenMutation() {
	return useMutation(RPC.orpc.battlemetrics.removeMyToken.mutationOptions({ onSuccess: invalidateMyToken }))
}

export function playerNotesQueryOptions(playerId: string) {
	return RPC.orpc.battlemetrics.listPlayerNotes.queryOptions({ input: { playerId }, staleTime: Infinity })
}

export namespace NotesActions {
	// skips the server's cached list
	export async function reload(playerId: string) {
		const res = await RPC.orpc.battlemetrics.listPlayerNotes.call({ playerId, fresh: true })
		RPC.queryClient.setQueryData(playerNotesQueryOptions(playerId).queryKey, res)
	}

	// Refetches the notes lists already loaded for these players, after a note was added to them. The server has
	// already added the note to its cached list, so this sends no request to BattleMetrics.
	export function refreshLoaded(playerIds: string[]) {
		for (const playerId of playerIds) {
			const { queryKey } = playerNotesQueryOptions(playerId)
			if (RPC.queryClient.getQueryData(queryKey) === undefined) continue
			void RPC.queryClient.invalidateQueries({ queryKey })
		}
	}
}

export function usePlayerFlagIds(playerId: string): string[] | null {
	return Zus.useStore(playerBmData$, (bmData) => bmData[playerId]?.flagIds) ?? null
}

export function usePlayerFlags(playerId: string): BM.PlayerFlag[] | null {
	const flagIds = usePlayerFlagIds(playerId)
	const orgFlags = useOrgFlags()
	if (flagIds === null || !orgFlags) return null
	return BM.resolveFlags(flagIds, orgFlags)
}

export function usePlayerProfile(playerId: string) {
	const player = Zus.useStore(playerBmData$, (bmData) => bmData[playerId])
	if (!player) return null
	const { flagIds: _, ...profile } = player
	return profile
}

// What decides a player's group colour, apart from their own flags.
export type GroupingInputs = {
	orgFlags: BM.PlayerFlag[] | undefined
	playerGroupings: PG.PlayerGroupings
	activeGroupingId: string | null
}

// The color of the group a player falls into under the active grouping, or null when nothing matches. The roster
// entry is passed in rather than looked up here: what it carries is per-server (the admin list a server recognises,
// the name it saw them under) and this has no server.
export function groupColorOf(
	inputs: GroupingInputs,
	flagIds: string[] | undefined,
	player: PG.PlayerFactsSource | undefined,
): string | null {
	const { orgFlags, playerGroupings, activeGroupingId } = inputs
	if (activeGroupingId === null || !player) return null
	const flags = flagIds && orgFlags ? BM.resolveFlags(flagIds, orgFlags) : []
	const group = PG.groupOf(playerGroupings, activeGroupingId, PG.playerFacts(player, flags))
	return group === undefined ? null : PG.groupColorOf(playerGroupings, activeGroupingId, group, orgFlags)
}

// identity-stable until one of the inputs changes
export function useGroupingInputs(): GroupingInputs {
	const orgFlags = useOrgFlags()
	const playerGroupings = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerGroupings) ?? PG.EMPTY_PLAYER_GROUPINGS
	const groupingIds = PG.groupingIdsWithParty(playerGroupings)
	const activeGroupingId = Zus.useStore(Store, Sel.activeGroupingId(groupingIds))
	return React.useMemo(() => ({ orgFlags, playerGroupings, activeGroupingId }), [orgFlags, playerGroupings, activeGroupingId])
}

// A player's group colour as of now, without subscribing to anything. For a row built from a template, which reads
// it once; whoever owns the row repaints it when the colour changes (see RC.applyGroupColors).
export function groupColorNow(playerId: string, player: PG.PlayerFactsSource | undefined): string | null {
	const playerGroupings = SettingsClient.PublicSettingsStore.getState()?.playerGroupings ?? PG.EMPTY_PLAYER_GROUPINGS
	const inputs: GroupingInputs = {
		orgFlags:
			RPC.queryClient.getQueryData(RPC.orpc.battlemetrics.listOrgFlags.queryOptions({ staleTime: Infinity }).queryKey) ?? undefined,
		playerGroupings,
		activeGroupingId: Sel.activeGroupingId(PG.groupingIdsWithParty(playerGroupings))(Store.getState()),
	}
	return groupColorOf(inputs, currentBmData()[playerId]?.flagIds, player)
}

function currentBmData(): BM.PublicPlayerBmData {
	const value = playerBmData$.getValue()
	return value instanceof Promise ? {} : value
}

// Re-renders only when this player's colour can have changed: their own flags, or the grouping itself.
export function usePlayerGroupColor(playerId: string, player: PG.PlayerFactsSource | undefined): string | null {
	const flagIds = Zus.useStore(playerBmData$, (bmData) => bmData[playerId]?.flagIds)
	return groupColorOf(useGroupingInputs(), flagIds, player)
}

export type PlayerGrouping = { groupingId: string; group: string; color: string }

// Every grouping this player lands in, in configured order, skipping the ones no rule matched them under -- which is
// what "Other" means, and is not worth a row each. Reports all of them rather than the active one: which grouping is
// active is a view setting, while a player's standing under each is a fact about them.
export function usePlayerGroupings(playerId: string, player: PG.PlayerFactsSource | undefined): PlayerGrouping[] {
	const flagIds = Zus.useStore(playerBmData$, (bmData) => bmData[playerId]?.flagIds)
	const orgFlags = useOrgFlags()
	const playerGroupings = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerGroupings)

	return React.useMemo(() => {
		if (!player) return []
		const configured = playerGroupings ?? PG.EMPTY_PLAYER_GROUPINGS
		const flags = flagIds && orgFlags ? BM.resolveFlags(flagIds, orgFlags) : []
		const facts = PG.playerFacts(player, flags)
		const groupings: PlayerGrouping[] = []
		for (const groupingId of PG.groupingIdsWithParty(configured)) {
			const group = PG.groupOf(configured, groupingId, facts)
			if (group === undefined) continue
			groupings.push({ groupingId, group, color: PG.groupColorOf(configured, groupingId, group, orgFlags) })
		}
		return groupings
	}, [player, flagIds, orgFlags, playerGroupings])
}

export function setup() {
	playerBmData$.subscribe()

	void (async () => {
		const orgFlagsRes = await RPC.queryClient.fetchQuery(RPC.orpc.battlemetrics.listOrgFlags.queryOptions({ staleTime: Infinity }))
		Store.setState({ orgFlags: orgFlagsRes ?? [] })
	})()
}
