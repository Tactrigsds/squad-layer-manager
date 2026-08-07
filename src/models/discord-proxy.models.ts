import { z } from 'zod'

// The wire between a demo-fleet instance and the control plane's guild-scoped discord api. An instance in proxy
// mode holds no bot token: it asks for the same things discord.server would have fetched from the gateway, and
// the control plane answers them for the one guild that instance belongs to.
//
// Both ends read this file, so a shape can never be right on one side and wrong on the other.

// the header carrying the per-instance secret, which is both the authentication and the guild scope: the control
// plane resolves it to an instance, and the instance to its guild
export const SECRET_HEADER = 'x-slm-proxy-secret'

// on the control plane: what an instance calls
export const API_PREFIX = '/_fleet/'
// on an instance: where forwarded gateway events land
export const EVENT_INGEST_PATH = '/_fleet/discord-event'

export const GuildSchema = z.object({ id: z.string(), name: z.string() })
export type Guild = z.infer<typeof GuildSchema>

export const GuildRoleSchema = z.object({ id: z.string(), name: z.string(), color: z.string().nullable() })
export type GuildRole = z.infer<typeof GuildRoleSchema>

export const GuildMemberSummarySchema = z.object({
	id: z.string(),
	displayName: z.string(),
	username: z.string(),
	avatarUrl: z.string(),
})
export type GuildMemberSummary = z.infer<typeof GuildMemberSummarySchema>

export const MemberSchema = z.object({
	id: z.string(),
	username: z.string(),
	globalName: z.string().nullable(),
	displayName: z.string(),
	avatarUrl: z.string(),
	displayHexColor: z.string().nullable(),
	roleIds: z.array(z.string()),
	// Manage Guild. A fleet instance's anti-lockout: nobody got to set SUPER_USERS on it, so who may administer it
	// is who may administer the guild it belongs to.
	holdsManageGuild: z.boolean(),
})
export type Member = z.infer<typeof MemberSchema>

export const EmojiSchema = z.object({ id: z.string(), name: z.string().nullable() })
export type Emoji = z.infer<typeof EmojiSchema>

// mirrors Discord.GuildRbacEvent, with the snowflake as a string because it crosses the wire.
//
// Carried in the query string rather than a body: the app installs a catch-all content type parser for oRPC that
// hands every route an undefined body, so a route that wants to read one has to reach past fastify to get it.
export const RbacEventSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('member'), discordId: z.string().regex(/^\d+$/) }),
	z.object({ type: z.literal('roles') }),
])
export type RbacEvent = z.infer<typeof RbacEventSchema>

export function eventToQuery(event: RbacEvent): string {
	return new URLSearchParams(event).toString()
}

// a lookup that names something the guild does not have, as against a call that failed
export const NotFoundSchema = z.object({ code: z.literal('err:not-found') })

export const MembersRolesRequestSchema = z.object({ memberIds: z.array(z.string()) })
export const MembersRolesResponseSchema = z.object({ members: z.array(z.object({ id: z.string(), roleIds: z.array(z.string()) })) })

export const SearchMembersResponseSchema = z.object({ members: z.array(GuildMemberSummarySchema) })
export const RolesResponseSchema = z.object({ roles: z.array(GuildRoleSchema) })
export const EmojisResponseSchema = z.object({ emojis: z.array(EmojiSchema) })
