import * as Arr from '@/lib/array'
import { assertNever } from '@/lib/type-guards'
import { Parts } from '@/lib/types'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import * as USR from '@/models/users.models'
import * as Zus from 'zustand'
import { immer as zustandImmerMiddleware } from 'zustand/middleware/immer'

export type ClientParts = USR.UserPart & LQY.LayerStatusPart & MH.MatchHistoryPart
type PartsStore = ClientParts & { upsert: <K extends keyof ClientParts>(key: K, entity: ClientParts[K]) => void }
export const PartsStore = Zus.createStore<PartsStore>()(
	zustandImmerMiddleware<PartsStore>((set) => {
		return {
			users: [],
			layerInPoolState: new Map(),
			layerStatuses: { blocked: new Map(), present: new Set(), violationDescriptors: new Map() },
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
						case 'layerStatuses': {
							draft.layerStatuses = entity as LQY.LayerStatuses
							break
						}
						case 'matchHistory': {
							const matchHistory = entity as MH.MatchHistoryPart['matchHistory']
							for (const entry of matchHistory.values()) {
								draft.matchHistory.set(entry.historyEntryId, entry)
							}
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

export function getLayerStatuses() {
	const statuses = PartsStore.getState().layerStatuses
	if (statuses.present.size === 0 && statuses.blocked.size === 0) return null
	return statuses
}

export function findMatchHistoryEntry(id: number) {
	return PartsStore.getState().matchHistory.get(id)
}
