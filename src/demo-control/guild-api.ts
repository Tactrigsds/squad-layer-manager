import * as D from 'discord.js'
import type * as Http from 'node:http'

import * as DP from '@/models/discord-proxy.models'

import * as Bot from './bot.ts'
import * as HttpUtil from './http-util.ts'
import * as Log from './log.ts'
import * as Registry from './registry.ts'
import * as Secrets from './secrets.ts'

// What an instance in proxy mode reads discord through. Every route here is scoped to the caller's own guild by
// construction: the secret in the header names the instance, and the instance names the guild. There is no
// parameter an instance could pass to reach another one's members.
//
// Rate limiting is discord.js's, on the one client: a single REST queue is the coordinated limiter the fleet
// needs, and 90 independent clients would be 90 uncoordinated ones.

const MEMBER_FETCH_BATCH = 100

let log!: ReturnType<typeof Log.forModule>

export function setup() {
	log = Log.forModule('guild-api')
}

type Caller = { instance: Registry.Instance; guild: D.Guild }

async function resolveCaller(req: Http.IncomingMessage): Promise<Caller | null> {
	const secret = req.headers[DP.SECRET_HEADER]
	if (typeof secret !== 'string') return null
	const instanceId = Secrets.instanceIdForProxySecret(secret)
	const instance = instanceId ? Registry.byId(instanceId) : undefined
	if (!instance || instance.kind !== 'guild' || !instance.guildId) return null
	if (!Bot.isEnabled()) return null
	const guild = await Bot.getClient()
		.guilds.fetch(instance.guildId)
		.catch(() => null)
	if (!guild) return null
	return { instance, guild }
}

export async function handle(req: Http.IncomingMessage, res: Http.ServerResponse, url: URL) {
	const caller = await resolveCaller(req)
	if (!caller) return HttpUtil.sendJson(res, 401, { code: 'err:unauthorized' })

	const path = url.pathname.slice(DP.API_PREFIX.length)
	try {
		switch (path) {
			case 'guild':
				return HttpUtil.sendJson(res, 200, { id: caller.guild.id, name: caller.guild.name } satisfies DP.Guild)
			case 'guild/roles':
				return HttpUtil.sendJson(res, 200, { roles: await listRoles(caller.guild) })
			case 'guild/member':
				return await member(res, caller, url)
			case 'guild/members/roles':
				return await membersRoles(req, res, caller)
			case 'guild/members/search':
				return await searchMembers(res, caller, url)
			case 'guild/emojis':
				return await emojis(res, caller)
			default:
				return HttpUtil.sendJson(res, 404, { code: 'err:not-found' })
		}
	} catch (err) {
		log.error({ err, path, guildId: caller.guild.id }, 'a guild api call failed')
		return HttpUtil.sendJson(res, 502, { code: 'err:discord' })
	}
}

async function listRoles(guild: D.Guild): Promise<DP.GuildRole[]> {
	const roles = await guild.roles.fetch()
	return [...roles.values()]
		.filter((role) => role.id !== guild.id) // @everyone's id equals the guild id
		.sort((a, b) => b.position - a.position)
		.map((role) => ({ id: role.id, name: role.name, color: role.color === 0 ? null : role.hexColor }))
}

async function member(res: Http.ServerResponse, caller: Caller, url: URL) {
	const id = url.searchParams.get('id')
	if (!id) return HttpUtil.sendJson(res, 400, { code: 'err:bad-request' })
	const found = await caller.guild.members.fetch(id).catch(() => null)
	if (!found) return HttpUtil.sendJson(res, 404, { code: 'err:not-found' })
	return HttpUtil.sendJson(res, 200, {
		id: found.id,
		username: found.user.username,
		globalName: found.user.globalName,
		displayName: found.displayName,
		avatarUrl: found.displayAvatarURL({ size: 128 }),
		displayHexColor: found.displayHexColor ?? found.user.hexAccentColor ?? null,
		roleIds: [...found.roles.cache.keys()],
		holdsManageGuild: found.permissions.has(D.PermissionFlagsBits.ManageGuild),
	} satisfies DP.Member)
}

// Batched the way discord.server's fetchMembersRoles is: the gateway takes up to 100 ids per request, and a member
// who has left is absent from the result rather than failing the batch.
async function membersRoles(req: Http.IncomingMessage, res: Http.ServerResponse, caller: Caller) {
	const parsed = DP.MembersRolesRequestSchema.safeParse(JSON.parse((await HttpUtil.readBody(req)).toString('utf8')))
	if (!parsed.success) return HttpUtil.sendJson(res, 400, { code: 'err:bad-request' })

	const members: { id: string; roleIds: string[] }[] = []
	for (let i = 0; i < parsed.data.memberIds.length; i += MEMBER_FETCH_BATCH) {
		const batch = parsed.data.memberIds.slice(i, i + MEMBER_FETCH_BATCH)
		try {
			const fetched = await caller.guild.members.fetch({ user: batch })
			for (const found of fetched.values()) members.push({ id: found.id, roleIds: [...found.roles.cache.keys()] })
		} catch (err) {
			log.warn({ err, guildId: caller.guild.id }, 'a member batch failed')
		}
	}
	return HttpUtil.sendJson(res, 200, { members })
}

async function searchMembers(res: Http.ServerResponse, caller: Caller, url: URL) {
	const query = url.searchParams.get('q') ?? ''
	const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100)
	const found = await caller.guild.members.search({ query, limit })
	const members: DP.GuildMemberSummary[] = [...found.values()].map((m) => ({
		id: m.id,
		displayName: m.displayName,
		username: m.user.username,
		avatarUrl: m.displayAvatarURL({ size: 32 }),
	}))
	return HttpUtil.sendJson(res, 200, { members })
}

async function emojis(res: Http.ServerResponse, caller: Caller) {
	const found = await caller.guild.emojis.fetch()
	const emojis: DP.Emoji[] = [...found.values()].map((emoji) => ({ id: emoji.id, name: emoji.name }))
	return HttpUtil.sendJson(res, 200, { emojis })
}
