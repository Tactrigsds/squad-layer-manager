import { useMutation } from '@tanstack/react-query'

import * as HQ from '@/models/history.models'
import * as RPC from '@/orpc.client'

export type QueryPageInput = { query: HQ.Query; cursor?: { time: number; serverEventId: number }; page?: number }

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

function invalidateSaved() {
	void RPC.queryClient.invalidateQueries({ queryKey: savedQueriesBase().queryKey })
}

export function useSaveQuery() {
	return useMutation(RPC.orpc.history.save.mutationOptions({ onSuccess: invalidateSaved }))
}

export function useDeleteSavedQuery() {
	return useMutation(RPC.orpc.history.deleteSaved.mutationOptions({ onSuccess: invalidateSaved }))
}

export function useSetRetain() {
	return useMutation(RPC.orpc.history.setRetain.mutationOptions({ onSuccess: invalidateSaved }))
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
