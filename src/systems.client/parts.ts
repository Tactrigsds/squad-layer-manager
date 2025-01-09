import { immer as zustandImmerMiddleware } from 'zustand/middleware/immer'
import * as Zus from 'zustand'
import * as M from '@/models'
import { assertNever } from '@/lib/typeGuards'
import { Parts } from '@/lib/types'

type PartsStore = M.UserPart & { upsert: (key: keyof ClientParts, entity: ClientParts[keyof ClientParts]) => void }
export type ClientParts = M.UserPart
export const PartsStore = Zus.create<PartsStore>()(
	zustandImmerMiddleware<PartsStore>((set, get) => {
		return {
			users: [],
			upsert(key, entity) {
				set((draft) => {
					switch (key) {
						case 'users': {
							for (const user of entity) {
								const existingIdx = draft.users.findIndex((u) => u.discordId === user.discordId)
								if (existingIdx === -1) {
									draft.users.push(user)
								} else {
									draft.users[existingIdx] = user
								}
							}
							break
						}
						default:
							assertNever(key)
					}
				})
			},
		}
	})
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
