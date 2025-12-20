import { resToOptional } from '@/lib/types'
import type * as CS from '@/models/context-shared'
import { toNormalizedEmoji } from '@/models/discord.models'
import { CONFIG } from '@/server/config'
import orpcBase from '@/server/orpc-base'
import * as D from 'discord.js'
import { z } from 'zod'
import * as Env from '@/server/env'
import { baseLogger } from '@/server/logger'

export const DiscordUserSchema = z.object({
	id: z.string().transform(BigInt),
	username: z.string(),
	// global_name: z.string(),
	// discriminator: z.string(),
	avatar: z.string().nullable(),
	// locale: z.string(),
	// flags: z.number(),
	// premium_type: z.number(),
	// public_flags: z.number(),
})

export type AccessToken = {
	access_token: string
	token_type: string
}

let client!: D.Client

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

export async function setup() {
	ENV = envBuilder()
	const ctx = { log: baseLogger }
	client = new D.Client({
		intents: [D.GatewayIntentBits.Guilds, D.GatewayIntentBits.GuildMembers],
	})

	await new Promise((resolve, reject) => {
		client.once('ready', () => {
			resolve(client)
		})
		client.once('error', (err) => {
			reject(err)
		})
		void client.login(ENV.DISCORD_BOT_TOKEN)
	})

	const res = await fetchGuild(ctx, CONFIG.homeDiscordGuildId)
	if (res.code !== 'ok') {
		throw new Error(`Could not find Discord server ${CONFIG.homeDiscordGuildId}`)
	}
	return res
}

export async function getOauthUser(token: AccessToken) {
	const fetchDiscordUserRes = await fetch('https://discord.com/api/users/@me', {
		headers: { Authorization: `${token.token_type} ${token.access_token}` },
	})
	if (!fetchDiscordUserRes.ok) {
		return Promise.resolve(null)
	}

	const data = await fetchDiscordUserRes.json()
	return DiscordUserSchema.parse(data)
}

async function fetchGuild(ctx: CS.Log, guildId: bigint) {
	try {
		const guild = await client.guilds.fetch(guildId.toString())
		return { code: 'ok' as const, guild }
	} catch (err) {
		ctx.log.warn({ err }, 'Failed to fetch guild with id %s', guildId)
		if (err instanceof D.DiscordAPIError) {
			return {
				code: 'err:discord' as const,
				msg: err.message,
				err: err.message,
				errCode: err.code,
			}
		}
		throw err
	}
}

export async function fetchMember(ctx: CS.Log, guildId: bigint, memberId: bigint) {
	const guildRes = await fetchGuild(ctx, guildId)
	if (guildRes.code !== 'ok') return guildRes

	try {
		const member = await guildRes.guild.members.fetch(memberId.toString())
		return { code: 'ok' as const, member }
	} catch (err) {
		ctx.log.warn({ err }, 'Failed to fetch member with id %s', memberId)
		if (err instanceof D.DiscordAPIError) {
			return {
				code: 'err:discord' as const,
				err: err.message,
				errCode: err.code,
			}
		}
		throw err
	}
}

export async function fetchGuildRoles(baseCtx: CS.Log) {
	const res = await fetchGuild(baseCtx, CONFIG.homeDiscordGuildId)
	if (res.code !== 'ok') {
		return res
	}
	const rolesMap = await res.guild.roles.fetch()
	return { code: 'ok' as const, roles: Object.keys(rolesMap) }
}

export const orpcRouter = {
	getGuildEmojis: orpcBase
		.input(z.object({}).optional())
		.handler(async ({ context }) => {
			const guildRes = await fetchGuild(context, CONFIG.homeDiscordGuildId)
			const guild = resToOptional(guildRes)!.guild
			let emojis = await guild.emojis.fetch()

			if (ENV.NODE_ENV === 'development') {
				emojis = client.emojis.cache
			}
			return emojis.map(emoji => toNormalizedEmoji(emoji))
		}),
}
