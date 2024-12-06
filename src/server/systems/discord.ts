import { z } from 'zod'
import * as C from '@/server/context'
import { baseLogger } from '../logger'
import { ENV } from '../env'
import * as D from 'discord.js'
import { CONFIG } from '@/server/config'

export const DiscordUserSchema = z.object({
	id: z.string().transform(BigInt),
	username: z.string(),
	global_name: z.string(),
	discriminator: z.string(),
	avatar: z.string(),
	locale: z.string(),
	flags: z.number(),
	premium_type: z.number(),
	public_flags: z.number(),
})

export type AccessToken = {
	access_token: string
	token_type: string
}

let client!: D.Client

export async function setupDiscordSystem() {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	using ctx = C.pushOperation({ log: baseLogger }, 'discord:setup', { level: 'info' })
	client = new D.Client({ intents: [D.GatewayIntentBits.Guilds, D.GatewayIntentBits.GuildMembers] })

	await new Promise((resolve, reject) => {
		client.once('ready', () => {
			resolve(client)
		})
		client.once('error', (err) => {
			reject(err)
		})
		client.login(ENV.DISCORD_BOT_TOKEN)
	})
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

async function fetchGuild(_ctx: C.Log, guildId: bigint) {
	using ctx = C.pushOperation(_ctx, 'discord:fetch-guild')
	try {
		const guild = await client.guilds.fetch(guildId.toString())
		return { code: 'ok' as const, guild }
	} catch (err) {
		ctx.log.warn({ err }, 'Failed to fetch guild with id %s', guildId)
		if (err instanceof D.DiscordAPIError) {
			return { code: 'err:discord' as const, err: err.message, errCode: err.code }
		}
		throw err
	}
}

async function fetchMember(_ctx: C.Log, guildId: bigint, memberId: bigint) {
	using ctx = C.pushOperation(_ctx, 'discord:fetch-member')
	const { code, guild } = await fetchGuild(ctx, guildId)
	if (code !== 'ok') return { code }

	try {
		const member = await guild.members.fetch(memberId.toString())
		return { code: 'ok' as const, member }
	} catch (err) {
		ctx.log.warn({ err }, 'Failed to fetch member with id %s', memberId)
		if (err instanceof D.DiscordAPIError) {
			return { code: 'err:discord' as const, err: err.message, errCode: err.code }
		}
		throw err
	}
}

export async function checkDiscordUserAuthorization(_ctx: C.Log, discordId: bigint) {
	using ctx = C.pushOperation(_ctx, 'discord:check-user-authorization')
	for (const authorized of CONFIG.authorizedDiscordRoles) {
		const res = await fetchMember(ctx, authorized.serverId, discordId)
		if (res.code != 'ok') return res
		if (res.member.roles.cache.has(authorized.roleId.toString())) {
			return { code: 'ok' as const }
		}
	}
	return { code: 'err:unauthorized' as const }
}
