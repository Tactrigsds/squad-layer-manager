import * as Arr from '@/lib/array'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import type * as LQY from '@/models/layer-queries.models'
import type * as MH from '@/models/match-history.models'
import type * as USR from '@/models/users.models'
import * as Zus from 'zustand'
import { immer as zustandImmerMiddleware } from 'zustand/middleware/immer'

export type ClientParts = USR.UserPart & MH.MatchHistoryPart & LQY.LayerItemStatusesPart
type PartsStore = ClientParts & { upsert: <K extends keyof ClientParts>(key: K, entity: ClientParts[K]) => void }
export const PartsStore = Zus.createStore<PartsStore>()(
	zustandImmerMiddleware<PartsStore>((set) => {
		return {
			users: [],
			layerInPoolState: new Map(),
			layerItemStatuses: { matching: new Map(), present: new Set(), matchDescriptors: new Map() },
			matchHistory: new Map(),
			upsert(key, entity) {
				set((draft) => {
					switch (key) {
						case 'users': {
							for (const user of entity as USR.User[]) {
								Arr.upsertOn(draft.users, user, 'discordId')
							}
							break
						}
						case 'matchHistory': {
							const matchHistory = entity as MH.MatchHistoryPart['matchHistory']
							for (const entry of matchHistory.values()) {
								draft.matchHistory.set(entry.historyEntryId, entry)
							}
							break
						}
						case 'layerItemStatuses': {
							draft.layerItemStatuses = entity as LQY.LayerItemStatusesPart['layerItemStatuses']
							break
						}
						default:
							assertNever(key)
					}
				})
			},
		}
	}),
)

export function stripParts<T extends Partial<Parts<Partial<ClientParts>>>>(withParts: T) {
	if (!withParts.parts) return withParts as Omit<T, 'parts'>
	upsertParts(withParts.parts)
	delete withParts.parts
	return withParts as Omit<T, 'parts'>
}

export function upsertParts(parts: Partial<ClientParts>) {
	for (const _key in parts) {
		const key = _key as keyof ClientParts
		PartsStore.getState().upsert(key, parts![key]!)
	}
}

export function findUser(id: bigint) {
	return PartsStore.getState().users.find((u) => u.discordId === id)
}

export function findMatchHistoryEntry(id: number) {
	return PartsStore.getState().matchHistory.get(id)
}

export function getServerLayerItemStatuses() {
	return PartsStore.getState().layerItemStatuses
}
