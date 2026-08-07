import * as D from 'discord.js'
import { z } from 'zod'

import { IsolatedSubject } from '@/lib/isolated-subject'
import { assertNever } from '@/lib/type-guards'
import { formatVersion } from '@/lib/versioning.ts'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared'
import * as DP from '@/models/discord-proxy.models'
import * as EMO from '@/models/emoji.models'
import * as RBAC from '@/rbac.models'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'

// Everything SLM reads out of discord, behind one of three drivers (DISCORD_MODE):
//
//   gateway - a bot token of this install's own, on the home guild. What a self-hosted SLM runs.
//   proxy   - no credentials at all: a demo-fleet control plane holds the one gateway session for the whole fleet
//             and answers for this instance's guild. See dev_docs/demo_fleet.md.
//   off     - no discord: users resolve from the db and guild roles go unread.
//
// The exports below are driver-neutral, which is why fetchMember returns a GuildMember of our own rather than
// discord.js's: only the gateway driver has one of those.

export const DiscordUserSchema = z.object({
	id: z.string().transform(BigInt),
	username: z.string(),
	avatar: z.string().nullable(),
})

export type AccessToken = {
	access_token: string
	token_type: string
}

// What every caller of fetchMember needs, and no more. `holdsManageGuild` is the one field discord.js does not
// spell this way; it is here because the demo fleet's guild instances have no SUPER_USERS to bootstrap from and
// take their anti-lockout from the guild instead (see rbac.server fetchIsSuperUser).
export type GuildMember = {
	id: bigint
	username: string
	globalName: string | null
	displayName: string
	avatarUrl: string
	displayHexColor: string | null
	roleIds: ReadonlySet<string>
	holdsManageGuild: boolean
}

export type LookupFailure =
	| { code: 'err:disabled'; err: string; errCode: undefined }
	| { code: 'err:discord'; err: string; errCode: number | undefined }

export type MemberResult = { code: 'ok'; member: GuildMember } | LookupFailure
export type RolesResult = { code: 'ok'; roles: DP.GuildRole[] } | LookupFailure
export type MembersResult = { code: 'ok'; members: DP.GuildMemberSummary[] } | LookupFailure

const DISABLED: LookupFailure = { code: 'err:disabled', err: 'discord integration disabled', errCode: undefined }

const module = initModule('discord')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

// home-guild membership/role changes that affect rbac, for consumers (rbac.server) to invalidate on. 'member' =
// one member's roles/membership changed (targeted); 'roles' = a role definition changed, affecting every holder.
export type GuildRbacEvent = { type: 'member'; discordId: bigint } | { type: 'roles' }
export const guildRbacEvents$ = new IsolatedSubject<GuildRbacEvent>()

type Driver = {
	setup(): Promise<void>
	homeGuildName(): string | null
	fetchMember(memberId: bigint): Promise<MemberResult>
	fetchMembersRoles(memberIds: bigint[]): Promise<Map<bigint, string[]>>
	listGuildRolesDetailed(): Promise<RolesResult>
	searchGuildMembers(query: string, limit: number): Promise<MembersResult>
	guildEmojis(): Promise<EMO.DiscordEmoji[]>
}

let driver!: Driver

export async function setup() {
	log = module.getLogger()
	ENV = envBuilder()
	switch (ENV.DISCORD_MODE) {
		case 'gateway':
			driver = gatewayDriver()
			break
		case 'proxy':
			driver = proxyDriver()
			break
		case 'off':
			driver = offDriver()
			break
		default:
			assertNever(ENV.DISCORD_MODE)
	}
	await driver.setup()
}

// Distinct from an ok result and from a failed lookup: an install running without discord resolves every user
// from the db, and callers report that as a fact about the install rather than as a per-lookup error.
export function isEnabled() {
	return (ENV?.DISCORD_MODE ?? 'off') !== 'off'
}

export function getHomeGuildName() {
	return driver?.homeGuildName() ?? null
}

export function fetchMember(memberId: bigint): Promise<MemberResult> {
	return driver.fetchMember(memberId)
}

// The role ids held by each of `memberIds`, for callers resolving many identities at once. Fetched in batches
// rather than one member at a time: the gateway takes up to 100 ids per request, and a member who has left the
// guild is simply absent from the result rather than failing the batch.
export function fetchMembersRoles(memberIds: bigint[]): Promise<Map<bigint, string[]>> {
	return driver.fetchMembersRoles(memberIds)
}

// roles with display info, for the settings role-assignment picker
export function listGuildRolesDetailed(): Promise<RolesResult> {
	return driver.listGuildRolesDetailed()
}

// prefix search across all guild members (username/nickname), for the settings user-assignment picker
export function searchGuildMembers(query: string, limit = 25): Promise<MembersResult> {
	return driver.searchGuildMembers(query, limit)
}

// A gateway event a demo-fleet control plane forwarded to this instance, since a proxy-mode instance has no
// gateway of its own to hear it on. Routed here rather than straight into the subject so the ingest endpoint has
// nothing to know about rbac.
export function ingestRbacEvent(event: DP.RbacEvent) {
	guildRbacEvents$.next(event.type === 'member' ? { type: 'member', discordId: BigInt(event.discordId) } : { type: 'roles' })
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

export const orpcRouter = {
	getGuildEmojis: orpcBase.input(z.object({}).optional()).handler(async () => driver.guildEmojis()),
}

// ============================== off ==============================

function offDriver(): Driver {
	return {
		async setup() {
			log.info('Discord integration is off (DISCORD_MODE=off); users resolve from the db and guild roles go unread')
		},
		homeGuildName: () => null,
		fetchMember: async () => DISABLED,
		fetchMembersRoles: async () => new Map(),
		listGuildRolesDetailed: async () => DISABLED,
		searchGuildMembers: async () => DISABLED,
		guildEmojis: async () => [],
	}
}

// ============================== gateway ==============================

const RESTART_SLM_COMMAND = 'restart-slm'
// how long to wait for graceful shutdown before forcing the exit
const RESTART_FORCE_EXIT_TIMEOUT = 10_000

function gatewayDriver(): Driver {
	let client!: D.Client
	let homeGuildName: string | null = null

	function toGuildMember(member: D.GuildMember): GuildMember {
		return {
			id: BigInt(member.id),
			username: member.user.username,
			globalName: member.user.globalName,
			displayName: member.displayName,
			avatarUrl: member.displayAvatarURL({ size: 128 }),
			displayHexColor: member.displayHexColor ?? member.user.hexAccentColor ?? null,
			roleIds: new Set(member.roles.cache.keys()),
			holdsManageGuild: member.permissions.has(D.PermissionFlagsBits.ManageGuild),
		}
	}

	async function fetchGuild() {
		try {
			const guild = await client.guilds.fetch(ENV.DISCORD_HOME_GUILD_ID.toString())
			return { code: 'ok' as const, guild }
		} catch (err) {
			log.warn({ err }, 'Failed to fetch guild with id %s', ENV.DISCORD_HOME_GUILD_ID)
			if (err instanceof D.DiscordAPIError) {
				return { code: 'err:discord' as const, err: err.message, errCode: err.code as number | undefined }
			}
			throw err
		}
	}

	// everything SLM resolves (members, roles, emojis) is scoped to the home guild, so an install in any other one
	// serves nobody and leaves the app with a presence no one here manages. Leave on sight, and sweep what we're
	// already in: the app may have been added elsewhere before this check existed.
	async function leaveForeignGuild(guild: D.Guild) {
		if (BigInt(guild.id) === ENV.DISCORD_HOME_GUILD_ID) return
		log.warn(
			'Leaving guild "%s" (%s): SLM only serves its configured home guild (DISCORD_HOME_GUILD_ID=%s)',
			guild.name,
			guild.id,
			ENV.DISCORD_HOME_GUILD_ID,
		)
		try {
			await guild.leave()
		} catch (err) {
			// the bot can't leave a guild it owns, and can't do much about it either
			log.error({ err }, 'Failed to leave guild "%s" (%s)', guild.name, guild.id)
		}
	}

	async function handleInteraction(interaction: D.Interaction) {
		if (!interaction.isChatInputCommand() || interaction.commandName !== RESTART_SLM_COMMAND) return
		try {
			// dynamic import: rbac.server statically imports this module
			const Rbac = await import('@/systems/rbac.server')
			const ctx = DB.addPooledDb({
				...CS.init(),
				user: { discordId: BigInt(interaction.user.id) },
				// TODO is this the best we can do?
				signal: CleanupSys.shutdownSignal,
			})
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
					version: formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA),
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

	return {
		async setup() {
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
				// a login failure that doesn't surface as an 'error' event would otherwise reject unobserved; route it to the connect promise
				client.login(ENV.DISCORD_BOT_TOKEN).catch(reject)
			})

			client.on('guildCreate', (guild) => void leaveForeignGuild(guild))
			await Promise.all(client.guilds.cache.map((guild) => leaveForeignGuild(guild)))

			const res = await fetchGuild()
			if (res.code !== 'ok') {
				// the bot can only fetch guilds it's a member of, so UnknownGuild here means the SLM application
				// hasn't been added to the configured guild (as opposed to a transient/permissions failure)
				if (res.errCode === D.RESTJSONErrorCodes.UnknownGuild) {
					const app = await client.application?.fetch().catch(() => null)
					const appName = app?.name ?? client.user?.username ?? 'unknown'
					log.fatal(
						{ appName, homeDiscordGuildId: ENV.DISCORD_HOME_GUILD_ID },
						'The Discord application is not installed in the configured guild. Invite the bot to that server and restart SLM.',
					)
					process.exit(1)
				}
				throw new Error(`Could not find Discord server ${ENV.DISCORD_HOME_GUILD_ID}`)
			}
			homeGuildName = res.guild.name

			await res.guild.commands.set([
				{ name: RESTART_SLM_COMMAND, description: 'Kill the SLM process so its container manager restarts it' },
			])
			client.on('interactionCreate', (interaction) => void handleInteraction(interaction))

			const homeGuildId = ENV.DISCORD_HOME_GUILD_ID.toString()
			client.on('guildMemberUpdate', (oldMember, newMember) => {
				if (newMember.guild.id !== homeGuildId) return
				// only roles matter for rbac; nickname/avatar edits don't change permissions
				const rolesChanged =
					oldMember.roles.cache.size !== newMember.roles.cache.size ||
					newMember.roles.cache.some((_, id) => !oldMember.roles.cache.has(id))
				if (rolesChanged) guildRbacEvents$.next({ type: 'member', discordId: BigInt(newMember.id) })
			})
			client.on('guildMemberAdd', (member) => {
				if (member.guild.id === homeGuildId) guildRbacEvents$.next({ type: 'member', discordId: BigInt(member.id) })
			})
			client.on('guildMemberRemove', (member) => {
				if (member.guild.id === homeGuildId) guildRbacEvents$.next({ type: 'member', discordId: BigInt(member.id) })
			})
			// a role definition/deletion/creation changes membership or grants for every holder
			client.on('roleCreate', (role) => {
				if (role.guild.id === homeGuildId) guildRbacEvents$.next({ type: 'roles' })
			})
			client.on('roleUpdate', (_, role) => {
				if (role.guild.id === homeGuildId) guildRbacEvents$.next({ type: 'roles' })
			})
			client.on('roleDelete', (role) => {
				if (role.guild.id === homeGuildId) guildRbacEvents$.next({ type: 'roles' })
			})
		},

		homeGuildName: () => homeGuildName,

		async fetchMember(memberId) {
			const guildRes = await fetchGuild()
			if (guildRes.code !== 'ok') return guildRes
			try {
				const member = await guildRes.guild.members.fetch(memberId.toString())
				return { code: 'ok', member: toGuildMember(member) }
			} catch (err) {
				log.warn({ err }, 'Failed to fetch member with id %s', memberId)
				if (err instanceof D.DiscordAPIError) {
					return { code: 'err:discord', err: err.message, errCode: err.code as number | undefined }
				}
				throw err
			}
		},

		async fetchMembersRoles(memberIds) {
			const roles = new Map<bigint, string[]>()
			if (memberIds.length === 0) return roles
			const guildRes = await fetchGuild()
			if (guildRes.code !== 'ok') return roles

			const BATCH = 100
			for (let i = 0; i < memberIds.length; i += BATCH) {
				const batch = memberIds.slice(i, i + BATCH).map((id) => id.toString())
				try {
					const members = await guildRes.guild.members.fetch({ user: batch })
					for (const member of members.values()) roles.set(BigInt(member.id), [...member.roles.cache.keys()])
				} catch (err) {
					log.warn({ err }, 'Failed to fetch a batch of %d guild members', batch.length)
				}
			}
			return roles
		},

		async listGuildRolesDetailed() {
			const res = await fetchGuild()
			if (res.code !== 'ok') return res
			const rolesMap = await res.guild.roles.fetch()
			const roles = [...rolesMap.values()]
				.filter((r) => r.id !== res.guild.id) // drop @everyone (its id equals the guild id)
				.sort((a, b) => b.position - a.position)
				.map((r) => ({ id: r.id, name: r.name, color: r.color === 0 ? null : r.hexColor }))
			return { code: 'ok', roles }
		},

		async searchGuildMembers(query, limit) {
			const res = await fetchGuild()
			if (res.code !== 'ok') return res
			const membersMap = await res.guild.members.search({ query, limit })
			const members = [...membersMap.values()].map((m) => ({
				id: m.id,
				displayName: m.displayName,
				username: m.user.username,
				avatarUrl: m.displayAvatarURL({ size: 32 }),
			}))
			return { code: 'ok', members }
		},

		async guildEmojis() {
			const guildRes = await fetchGuild()
			if (guildRes.code !== 'ok') return []
			let emojis = await guildRes.guild.emojis.fetch()
			if (ENV.NODE_ENV === 'development') {
				emojis = client.emojis.cache
			}
			return emojis.map((emoji) => ({ id: EMO.createDiscordEmojiId(emoji.id), name: emoji.name, type: 'discord' as const }))
		},
	}
}

// ============================== proxy ==============================

// A demo-fleet instance holds no discord credentials: a bot token here would be the fleet's, and the gateway
// driver above would then make the application leave every other guild it is installed in. It asks the control
// plane instead, which scopes every answer to this instance's own guild.
function proxyDriver(): Driver {
	let homeGuildName: string | null = null

	function config() {
		if (!ENV.DISCORD_PROXY_URL || !ENV.DISCORD_PROXY_SECRET) {
			throw new Error('DISCORD_MODE=proxy needs DISCORD_PROXY_URL and DISCORD_PROXY_SECRET')
		}
		return { url: ENV.DISCORD_PROXY_URL, secret: ENV.DISCORD_PROXY_SECRET }
	}

	async function call<T extends z.ZodType>(
		schema: T,
		path: string,
		init?: { method: 'POST'; body: unknown },
	): Promise<{ code: 'ok'; data: z.infer<T> } | LookupFailure> {
		const { url, secret } = config()
		try {
			const response = await fetch(`${url}${DP.API_PREFIX}${path}`, {
				method: init?.method ?? 'GET',
				headers: { [DP.SECRET_HEADER]: secret, ...(init ? { 'content-type': 'application/json' } : {}) },
				body: init ? JSON.stringify(init.body) : undefined,
				signal: AbortSignal.timeout(10_000),
			})
			if (!response.ok) {
				return { code: 'err:discord', err: `the control plane answered ${response.status}`, errCode: response.status }
			}
			return { code: 'ok', data: schema.parse(await response.json()) }
		} catch (err) {
			log.warn({ err, path }, 'a guild proxy call failed')
			return { code: 'err:discord', err: err instanceof Error ? err.message : String(err), errCode: undefined }
		}
	}

	return {
		async setup() {
			const res = await call(DP.GuildSchema, 'guild')
			if (res.code === 'ok') homeGuildName = res.data.name
			else log.warn('could not read the guild through the control plane at boot: %s', res.err)
		},

		homeGuildName: () => homeGuildName,

		async fetchMember(memberId) {
			const res = await call(DP.MemberSchema, `guild/member?id=${memberId}`)
			if (res.code !== 'ok') return res
			return {
				code: 'ok',
				member: {
					id: BigInt(res.data.id),
					username: res.data.username,
					globalName: res.data.globalName,
					displayName: res.data.displayName,
					avatarUrl: res.data.avatarUrl,
					displayHexColor: res.data.displayHexColor,
					roleIds: new Set(res.data.roleIds),
					holdsManageGuild: res.data.holdsManageGuild,
				},
			}
		},

		async fetchMembersRoles(memberIds) {
			const roles = new Map<bigint, string[]>()
			if (memberIds.length === 0) return roles
			const res = await call(DP.MembersRolesResponseSchema, 'guild/members/roles', {
				method: 'POST',
				body: { memberIds: memberIds.map(String) },
			})
			if (res.code !== 'ok') return roles
			for (const member of res.data.members) roles.set(BigInt(member.id), member.roleIds)
			return roles
		},

		async listGuildRolesDetailed() {
			const res = await call(DP.RolesResponseSchema, 'guild/roles')
			return res.code === 'ok' ? { code: 'ok', roles: res.data.roles } : res
		},

		async searchGuildMembers(query, limit) {
			const res = await call(DP.SearchMembersResponseSchema, `guild/members/search?q=${encodeURIComponent(query)}&limit=${limit}`)
			return res.code === 'ok' ? { code: 'ok', members: res.data.members } : res
		},

		async guildEmojis() {
			const res = await call(DP.EmojisResponseSchema, 'guild/emojis')
			if (res.code !== 'ok') return []
			return res.data.emojis.map((emoji) => ({ id: EMO.createDiscordEmojiId(emoji.id), name: emoji.name, type: 'discord' as const }))
		},
	}
}
