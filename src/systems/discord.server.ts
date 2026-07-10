import { resToOptional } from '@/lib/types'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared'
import { toNormalizedEmoji } from '@/models/discord.models'
import * as RBAC from '@/rbac.models'
import { initModule } from '@/server/logger'
import * as AppEventsSys from '@/systems/app-events.server'

import * as DB from '@/server/db'
import * as Env from '@/server/env'

import { getOrpcBase } from '@/server/orpc-base'
import * as D from 'discord.js'
import { z } from 'zod'

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

const module = initModule('discord')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

let client!: D.Client

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

export async function setup() {
	log = module.getLogger()
	ENV = envBuilder()
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

	const res = await fetchGuild(ENV.DISCORD_HOME_GUILD_ID)
	if (res.code !== 'ok') {
		// the bot can only fetch guilds it's a member of, so UnknownGuild here means the SLM application
		// hasn't been added to the configured guild (as opposed to a transient/permissions failure)
		if (res.errCode === D.RESTJSONErrorCodes.UnknownGuild) {
			const app = await client.application?.fetch().catch(() => null)
			const appName = app?.name ?? client.user?.username ?? 'unknown'
			log.fatal(
				'The "%s" Discord application is not installed in the configured guild (homeDiscordGuildId=%s). '
					+ 'Invite the bot to that server and restart SLM.',
				appName,
				ENV.DISCORD_HOME_GUILD_ID,
			)
			process.exit(1)
		}
		throw new Error(`Could not find Discord server ${ENV.DISCORD_HOME_GUILD_ID}`)
	}

	await res.guild.commands.set([
		{ name: RESTART_SLM_COMMAND, description: 'Kill the SLM process so its container manager restarts it' },
	])
	client.on('interactionCreate', (interaction) => void handleInteraction(interaction))

	return res
}

const RESTART_SLM_COMMAND = 'restart-slm'
// how long to wait for graceful shutdown before forcing the exit
const RESTART_FORCE_EXIT_TIMEOUT = 10_000

async function handleInteraction(interaction: D.Interaction) {
	if (!interaction.isChatInputCommand() || interaction.commandName !== RESTART_SLM_COMMAND) return
	try {
		// dynamic import: rbac.server statically imports this module
		const Rbac = await import('@/systems/rbac.server')
		const ctx = DB.addPooledDb({ ...CS.init(), user: { discordId: BigInt(interaction.user.id) } })
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:restart-slm'))
		if (denyRes) {
			await interaction.reply({ content: 'You are not authorized to restart SLM.', flags: D.MessageFlags.Ephemeral })
			return
		}
		await interaction.reply({ content: 'Shutting down SLM. It should be restarted shortly.' })
		log.warn('restart-slm invoked by %s (%s), shutting down', interaction.user.username, interaction.user.id)
		await AppEventsSys.persistAppEvent(
			ctx,
			AppEvents.create<AppEvents.AppRestarted>({
				type: 'APP_RESTARTED',
				actor: { type: 'slm-user', userId: ctx.user.discordId },
				serverId: null,
				matchId: null,
				causeId: null,
			}),
		)
		setTimeout(() => process.exit(1), RESTART_FORCE_EXIT_TIMEOUT)
		process.kill(process.pid, 'SIGTERM')
	} catch (err) {
		log.error({ err }, 'Failed to handle %s command', RESTART_SLM_COMMAND)
		if (interaction.isRepliable() && !interaction.replied) {
			await interaction.reply({ content: 'Something went wrong.', flags: D.MessageFlags.Ephemeral }).catch(() => {})
		}
	}
}

export async function getOauthUser(ctx: Partial<CS.AbortSignal>, token: AccessToken) {
	const fetchDiscordUserRes = await fetch('https://discord.com/api/users/@me', {
		headers: { Authorization: `${token.token_type} ${token.access_token}` },
		signal: ctx.signal,
	})
	if (!fetchDiscordUserRes.ok) {
		return Promise.resolve(null)
	}

	const data = await fetchDiscordUserRes.json()
	return DiscordUserSchema.parse(data)
}

async function fetchGuild(guildId: bigint) {
	try {
		const guild = await client.guilds.fetch(guildId.toString())
		return { code: 'ok' as const, guild }
	} catch (err) {
		log.warn({ err }, 'Failed to fetch guild with id %s', guildId)
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

export async function fetchMember(guildId: bigint, memberId: bigint) {
	const guildRes = await fetchGuild(guildId)
	if (guildRes.code !== 'ok') return guildRes

	try {
		const member = await guildRes.guild.members.fetch(memberId.toString())
		return { code: 'ok' as const, member }
	} catch (err) {
		log.warn({ err }, 'Failed to fetch member with id %s', memberId)
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

export async function fetchGuildRoles() {
	const res = await fetchGuild(ENV.DISCORD_HOME_GUILD_ID)
	if (res.code !== 'ok') {
		return res
	}
	const rolesMap = await res.guild.roles.fetch()
	return { code: 'ok' as const, roles: Object.keys(rolesMap) }
}

// roles with display info, for the settings role-assignment picker
export async function listGuildRolesDetailed() {
	const res = await fetchGuild(ENV.DISCORD_HOME_GUILD_ID)
	if (res.code !== 'ok') return res
	const rolesMap = await res.guild.roles.fetch()
	const roles = [...rolesMap.values()]
		.filter((r) => r.id !== res.guild.id) // drop @everyone (its id equals the guild id)
		.sort((a, b) => b.position - a.position)
		.map((r) => ({ id: r.id, name: r.name, color: r.color === 0 ? null : r.hexColor }))
	return { code: 'ok' as const, roles }
}

// prefix search across all guild members (username/nickname), for the settings user-assignment picker
export async function searchGuildMembers(query: string, limit = 25) {
	const res = await fetchGuild(ENV.DISCORD_HOME_GUILD_ID)
	if (res.code !== 'ok') return res
	const membersMap = await res.guild.members.search({ query, limit })
	const members = [...membersMap.values()].map((m) => ({
		id: m.id,
		displayName: m.displayName,
		username: m.user.username,
		avatarUrl: m.displayAvatarURL({ size: 32 }),
	}))
	return { code: 'ok' as const, members }
}

export const orpcRouter = {
	getGuildEmojis: orpcBase
		.input(z.object({}).optional())
		.handler(async () => {
			const guildRes = await fetchGuild(ENV.DISCORD_HOME_GUILD_ID)
			const guild = resToOptional(guildRes)!.guild
			let emojis = await guild.emojis.fetch()

			if (ENV.NODE_ENV === 'development') {
				emojis = client.emojis.cache
			}
			return emojis.map(emoji => toNormalizedEmoji(emoji))
		}),
}
