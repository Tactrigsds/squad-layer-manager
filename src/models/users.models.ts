import type * as SchemaModels from '$root/drizzle/schema.models'
import { z } from 'zod'
export type GuiUserId = { discordId: bigint }
export type ChatUserId = { steamId: string }
export type GuiOrChatUserId = { discordId?: bigint; steamId?: string }

export type User = SchemaModels.User
export type MiniUser = {
	username: string
	discordId: string
}

export type UserPart = { users: User[] }

export type UserPresenceState = {
	editState?: {
		userId: bigint
		wsClientId: string
		startTime: number
	}
}
export type UserPresenceStateUpdate = {
	state: UserPresenceState
	event: 'edit-start' | 'edit-end' | 'edit-kick'
}

// represents a user's edit or deletion of an entity
export type UserEntityMutation<K extends string | number, V> = {
	username: string
	key: K
	value: V
	type: 'add' | 'update' | 'delete'
}

// should eventually replace all user id validation with this
export const UserIdSchema = z.bigint().positive()
