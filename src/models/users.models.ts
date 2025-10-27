import type * as SchemaModels from '$root/drizzle/schema.models'
import * as AR from '@/app-routes'
import { z } from 'zod'

export const GuiUserIdSchema = z.object({
	discordId: z.bigint(),
})

export type GuiUserId = z.infer<typeof GuiUserIdSchema>

export const ChatUserIdSchema = z.object({
	steamId: z.string(),
})

export type ChatUserId = z.infer<typeof ChatUserIdSchema>

export const GuiOrChatUserIdSchema = z.object({
	discordId: z.bigint().optional(),
	steamId: z.string().optional(),
})

export type GuiOrChatUserId = z.infer<typeof GuiOrChatUserIdSchema>

export type User = SchemaModels.User & {
	username: string
	displayName: string
	displayHexColor: string | null
	avatar: string | null
	nickname: string | null
}
export type MiniUser = {
	username: string
	discordId: string
}

export type UserPart = { users: User[] }

// represents a user's edit or deletion of an entity
export type UserEntityMutation<K extends string | number, V> = {
	username: string
	displayName: string
	key: K
	value: V
	type: 'add' | 'update' | 'delete'
}

// should eventually replace all user id validation with this
export const UserIdSchema = z.bigint().positive()

export type UserId = z.infer<typeof UserIdSchema>

export const getAvatarUrl = (user: User) => {
	if (user.avatar) return AR.link('/discord-cdn/*', `avatars/${user.discordId}/${user.avatar}.png`)
	const id = ((user.discordId >> 22n) % 6n).toString()
	return AR.link('/discord-cdn/*', `embed/avatars/${id}.png`)
}

export const getUserInitials = (user: User) => {
	return user.username?.slice(0, 2).toUpperCase()
}
