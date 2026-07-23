import type * as SchemaModels from '$root/drizzle/schema.models'
import * as DM from '@/models/discord.models'
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
	// TODO we should probably be using eosId here
	steamId: z.string().optional(),
})

// TODO outdated
export type GuiOrChatUserId = z.infer<typeof GuiOrChatUserIdSchema>

export type User = SchemaModels.User & {
	username: string
	displayName: string
	displayHexColor: string | null
	avatarUrl: string
	nickname: string | null
}
export type MiniUser = {
	displayName: string
	discordId: bigint
}

// reduce down a type that's assignable to MiniUser
export function toMiniUser(user: MiniUser): MiniUser {
	return {
		displayName: user.displayName,
		discordId: user.discordId,
	}
}

export type UserPart = { users: User[] }

// represents a user's edit or deletion of an entity. Carries the actor's id, not their name: consumers resolve
// the display name so it reflects the user's current nickname rather than whatever it was at mutation time.
export type UserEntityMutation<K extends string | number, V> = {
	userId: UserId
	key: K
	value: V
	type: 'add' | 'update' | 'delete'
}

// should eventually replace all user id validation with this
export const UserIdSchema = z.bigint().positive()

export type UserId = z.infer<typeof UserIdSchema>

// only for users we couldn't resolve against discord; otherwise the url comes from discord.js, which
// knows about guild-specific and animated avatars. Mirrors discord.js' User#defaultAvatarURL.
export const getDefaultAvatarUrl = (discordId: bigint) => {
	const index = ((discordId >> 22n) % 6n).toString()
	return `${DM.CDN_BASE}/embed/avatars/${index}.png`
}

export const getUserInitials = (user: User) => {
	return user.username?.slice(0, 2).toUpperCase()
}
