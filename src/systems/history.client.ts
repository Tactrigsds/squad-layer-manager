import { useMutation } from '@tanstack/react-query'

import * as HQ from '@/models/history.models'
import * as RPC from '@/orpc.client'

export type QueryPageInput = {
	query: HQ.Query
	cursor?: { time: number; serverEventId?: number; appEventId?: string }
	page?: number
	// events rows are rendered server-side, so the viewer's display settings ride along
	render?: { displayTeamsNormalized: boolean; locale: string }
	includeMatchBoundaries?: boolean
}

export const queryPageBase = (input: QueryPageInput) =>
	RPC.orpc.history.query.queryOptions({
		input,
		staleTime: 30_000,
	})

export const savedQueriesBase = () =>
	RPC.orpc.history.listSaved.queryOptions({
		input: undefined,
		staleTime: 30_000,
	})

// a needle shorter than the trigram index's three characters scans the players table, so it is not sent
export const MIN_PLAYER_NEEDLE = 3

export const playerSearchBase = (needle: string) =>
	RPC.orpc.history.searchPlayers.queryOptions({
		input: { needle },
		enabled: needle.trim().length >= MIN_PLAYER_NEEDLE,
		staleTime: 60_000,
	})

export const playerInfoBase = (playerId: string | undefined) =>
	RPC.orpc.history.playerInfo.queryOptions({
		input: { playerId: playerId ?? '' },
		enabled: !!playerId,
		staleTime: Infinity,
	})

// the whole (small) user table, filtered client-side: see history.server's listUsers
export const usersBase = () =>
	RPC.orpc.history.listUsers.queryOptions({
		input: undefined,
		staleTime: 5 * 60_000,
	})

export const playerLabelsBase = (playerIds: string[]) =>
	RPC.orpc.history.playerLabels.queryOptions({
		input: { playerIds },
		enabled: playerIds.length > 0,
		staleTime: Infinity,
	})

function invalidateSaved() {
	void RPC.queryClient.invalidateQueries({ queryKey: savedQueriesBase().queryKey })
}

export function useSaveQuery() {
	return useMutation(RPC.orpc.history.save.mutationOptions({ onSuccess: invalidateSaved }))
}

export function useDeleteSavedQuery() {
	return useMutation(RPC.orpc.history.deleteSaved.mutationOptions({ onSuccess: invalidateSaved }))
}

// -------- the builder rail's width --------
// same reasoning as recents: a per-browser convenience, and nothing else should inherit it

const RAIL_WIDTH_KEY = 'slm:history:railWidth'
export const RAIL_WIDTH = { min: 220, max: 560, default: 288 }

export function loadRailWidth(): number {
	try {
		// an unset key reads as null, and Number(null) is 0, which would clamp to the minimum rather than
		// falling back to the default
		const stored = localStorage.getItem(RAIL_WIDTH_KEY)
		const raw = stored === null ? Number.NaN : Number(stored)
		if (!Number.isFinite(raw)) return RAIL_WIDTH.default
		return Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, raw))
	} catch {
		return RAIL_WIDTH.default
	}
}

export function saveRailWidth(width: number) {
	try {
		localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(width)))
	} catch {
		// a browser with storage denied still resizes, it just does not remember
	}
}

// -------- recents --------
// purely a convenience, so localStorage is the right home: per browser, survives nothing it shouldn't

const RECENTS_KEY = 'slm:history:recents'
const MAX_RECENTS = 20

export type Recent = { query: HQ.Query; at: number }

export function loadRecents(): Recent[] {
	try {
		const raw = localStorage.getItem(RECENTS_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		const recents: Recent[] = []
		for (const entry of parsed) {
			const query = HQ.QuerySchema.safeParse(entry?.query)
			if (query.success && typeof entry.at === 'number') recents.push({ query: query.data, at: entry.at })
		}
		return recents
	} catch {
		return []
	}
}

export function pushRecent(query: HQ.Query) {
	const key = JSON.stringify(query)
	const rest = loadRecents().filter((r) => JSON.stringify(r.query) !== key)
	const next = [{ query, at: Date.now() }, ...rest].slice(0, MAX_RECENTS)
	try {
		localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
	} catch {
		// storage full or unavailable: recents are a convenience, not state
	}
}
