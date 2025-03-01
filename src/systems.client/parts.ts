import { assertNever } from '@/lib/typeGuards'
import { Parts } from '@/lib/types'
import * as M from '@/models'
import * as Zus from 'zustand'
import { immer as zustandImmerMiddleware } from 'zustand/middleware/immer'

export type ClientParts = M.UserPart & M.LayerStatusPart
type PartsStore = ClientParts & { upsert: <K extends keyof ClientParts>(key: K, entity: ClientParts[K]) => void }
export const PartsStore = Zus.createStore<PartsStore>()(
	zustandImmerMiddleware<PartsStore>((set) => {
		return {
			users: [],
			layerInPoolState: new Map(),
			upsert(key, entity) {
				set((draft) => {
					switch (key) {
						case 'users': {
							for (const user of entity as M.User[]) {
								const existingIdx = draft.users.findIndex((u) => u.discordId === user.discordId)
								if (existingIdx === -1) {
									draft.users.push(user)
								} else {
									draft.users[existingIdx] = user
								}
							}
							break
						}
						case 'layerInPoolState': {
							for (const [id, state] of (entity as Map<string, M.LayerStatus>).entries()) {
								draft.layerInPoolState.set(id, state)
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

export function findLayerState(poolFilterId: M.FilterEntityId, layerId: M.LayerId) {
	const id = M.getLayerStatusId(layerId, poolFilterId)
	return PartsStore.getState().layerInPoolState.get(id)
}
