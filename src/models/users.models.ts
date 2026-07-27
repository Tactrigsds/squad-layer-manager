import { z } from 'zod'

import type * as SchemaModels from '$root/drizzle/schema.models'
import * as CD from '@/lib/ctx-def'
import type * as CS from '@/models/context-shared'
import * as DM from '@/models/discord.models'

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

// What the no-auth login portal posts. There is no identity provider behind it, so the name typed into the
// form is the whole identity; it is bounded and kept to printable characters only because it is displayed
// everywhere a discord username would be.
export const NoAuthLoginSchema = z.object({
	username: z
		.string()
		.trim()
		.min(1)
		.max(32)
		.regex(/^[\p{L}\p{N} ._-]+$/u),
})

// A steam account linked to a discord account, as shown to a client. Ids are strings: neither a steam64 nor a
// discord snowflake survives a trip through JSON as a number.
export type SteamAccountLink = {
	steamId: string
	discordId: string
	discordUsername: string
	origin: SchemaModels.LinkOrigin
	// who assigned it, named for display. null for a self-serve link, and for an assigner whose account is gone.
	linkedBy: { discordId: string; displayName: string } | null
	createdAt: Date
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

export type Ctx = CS.Ctx & {
	user: User
}
export const CtxDef = CD.defCtx<Ctx>()(['user'], { name: 'user', collisions: ['user'] })

export namespace Ctx {
	// the same key at a narrower width: a function that only needs the id declares this and accepts
	// either. Deliberate, and depended on by 13 signatures.
	export type Id = CS.Ctx & {
		user: { discordId: bigint }
	}
	export const IdDef = CD.defCtx<Id>()(['user'], { name: 'userId', collisions: ['user'] })
}
