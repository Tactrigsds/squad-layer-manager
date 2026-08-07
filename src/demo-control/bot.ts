import * as D from 'discord.js'
import fs from 'node:fs/promises'

import { assertNever } from '@/lib/type-guards'
import * as DP from '@/models/discord-proxy.models'

import * as ControlEnv from './env.ts'
import * as Log from './log.ts'
import * as Messages from './messages.ts'
import * as Registry from './registry.ts'
import * as Secrets from './secrets.ts'
import * as Spawner from './spawner.ts'

// One gateway session for the whole fleet. Not one per instance: 90 sessions would spend the 1000 session-starts
// a day an application gets on respawns alone, and an instance holding the bot token would run
// discord.server's leaveForeignGuild against every other guild the app is installed in.
//
// So the bot lives here, and instances reach discord through the guild-scoped api in guild-api.ts.

let client: D.Client | undefined
let log!: ReturnType<typeof Log.forModule>

export function getClient(): D.Client {
	if (!client) throw new Error('the guild flow is off; there is no discord client')
	return client
}

export function isEnabled(): boolean {
	return client !== undefined
}

export async function setup(signal: AbortSignal) {
	log = Log.forModule('bot')
	const env = ControlEnv.get()
	client = new D.Client({ intents: [D.GatewayIntentBits.Guilds, D.GatewayIntentBits.GuildMembers] })

	await new Promise((resolve, reject) => {
		client!.once('ready', resolve)
		client!.once('error', reject)
		client!.login(env.DEMO_DISCORD_BOT_TOKEN).catch(reject)
	})
	log.info('gateway session up as %s', client.user?.username)

	client.on('guildCreate', (guild) => void onInstalled(guild))
	client.on('guildDelete', (guild) => void onRemoved(guild))

	// what rbac on an instance invalidates against. Forwarded rather than polled: an instance in proxy mode has no
	// gateway of its own, and a role change nobody notices is a permission that never takes effect.
	client.on('guildMemberUpdate', (oldMember, newMember) => {
		const rolesChanged =
			oldMember.roles.cache.size !== newMember.roles.cache.size || newMember.roles.cache.some((_, id) => !oldMember.roles.cache.has(id))
		if (rolesChanged) void forward(newMember.guild.id, { type: 'member', discordId: newMember.id })
	})
	client.on('guildMemberAdd', (member) => void forward(member.guild.id, { type: 'member', discordId: member.id }))
	client.on('guildMemberRemove', (member) => void forward(member.guild.id, { type: 'member', discordId: member.id }))
	client.on('roleCreate', (role) => void forward(role.guild.id, { type: 'roles' }))
	client.on('roleUpdate', (_, role) => void forward(role.guild.id, { type: 'roles' }))
	client.on('roleDelete', (role) => void forward(role.guild.id, { type: 'roles' }))

	await reconcile()
	signal.addEventListener('abort', () => void close(), { once: true })
}

// The gateway is not a queue: an install or a removal that happened while the control plane was down is simply
// absent from it. Both directions, because either kind of drift leaves something that serves nobody -- an
// instance with no guild behind it, or a guild whose members reach a 404.
async function reconcile() {
	const guilds = await client!.guilds.fetch()
	const known = new Set(
		Registry.all()
			.filter((i) => i.kind === 'guild')
			.map((i) => i.guildId!),
	)

	for (const [guildId] of guilds) {
		if (known.has(guildId)) continue
		log.info({ guildId }, 'provisioning an instance for a guild installed while we were down')
		const guild = await client!.guilds.fetch(guildId).catch(() => null)
		if (guild) await onInstalled(guild)
	}

	for (const instance of Registry.all()) {
		if (instance.kind !== 'guild' || !instance.guildId) continue
		if (guilds.has(instance.guildId)) continue
		log.info({ guildId: instance.guildId }, 'reaping an instance whose guild removed us while we were down')
		await removeInstance(instance)
	}
}

// Provisioning is reached from two directions: this gateway event, and the installer's browser coming back
// through the broker. Whichever arrives first does the work. Registry.create is synchronous, so the other cannot
// interleave and find a half-made instance.
export function ensureProvisioned(guildId: string): { code: 'ok'; instance: Registry.Instance } | { code: 'err:at-capacity' } {
	const existing = Registry.byGuild(guildId)
	if (existing) return { code: 'ok', instance: existing }

	const created = Registry.create({ kind: 'guild', guildId })
	switch (created.code) {
		case 'ok':
		case 'err:exists':
			return { code: 'ok', instance: created.instance }
		case 'err:at-capacity':
			return { code: 'err:at-capacity' }
		default:
			assertNever(created)
	}
}

async function onInstalled(guild: D.Guild) {
	// A guild we already serve. Discord replays GUILD_CREATE for reasons that are not an install (an outage
	// clearing, a genuine reinstall), and none of them are worth a second copy of the welcome message.
	if (Registry.byGuild(guild.id)) {
		log.info({ guildId: guild.id }, 'guildCreate for a guild that already has an instance')
		return
	}

	const provisioned = ensureProvisioned(guild.id)
	if (provisioned.code === 'err:at-capacity') {
		log.warn({ guildId: guild.id, guildName: guild.name }, 'at guild capacity; leaving')
		await dmOwner(guild, Messages.atCapacity(ControlEnv.get().apexOrigin))
		await guild.leave().catch((err) => log.error({ err, guildId: guild.id }, 'could not leave a guild we are at capacity for'))
		return
	}

	// Best effort, and no longer the only way anyone learns the url: whoever added the app is redirected onto the
	// instance directly (see broker.completeInstall). This reaches the owner, who may be somebody else entirely
	// and may not accept DMs.
	await dmOwner(guild, Messages.welcome(instanceUrl(provisioned.instance)))
	void Spawner.start(provisioned.instance)
}

async function onRemoved(guild: D.Guild) {
	const instance = Registry.byGuild(guild.id)
	if (!instance) return
	log.info({ guildId: guild.id }, 'removed from a guild; reaping its instance')
	await removeInstance(instance)
}

// Deliberately not reaper.reap: that one asks the bot to leave, and here the guild has already gone (or we are
// about to leave it ourselves).
async function removeInstance(instance: Registry.Instance) {
	await Spawner.stop(instance.id)
	Secrets.forgetInstance(instance.id)
	Registry.remove(instance.id)
	await fs
		.rm(Registry.dataDir(instance), { recursive: true, force: true })
		.catch((err) => log.error({ err, instanceId: instance.id }, 'could not delete a removed instance data directory'))
}

export async function leaveGuild(guildId: string, reason: 'idle') {
	if (!client) return
	const guild = await client.guilds.fetch(guildId).catch(() => null)
	if (!guild) return
	await dmOwner(guild, Messages.reapedForIdleness(ControlEnv.get().apexOrigin, reason))
	await guild.leave().catch((err) => log.error({ err, guildId }, 'could not leave a guild after reaping its instance'))
}

function instanceUrl(instance: Registry.Instance): string {
	return `${Registry.origin(instance)}/`
}

// The app installs with no permissions, so it has no channel it may post in. The owner is the one member it can
// always reach, and is who decided to install it.
async function dmOwner(guild: D.Guild, content: string) {
	try {
		const owner = await guild.fetchOwner()
		await owner.send(content)
	} catch (err) {
		log.warn({ err, guildId: guild.id }, 'could not dm the owner of %s', guild.name)
	}
}

async function forward(guildId: string, event: DP.RbacEvent) {
	const instance = Registry.byGuild(guildId)
	if (!instance || !Spawner.isRunning(instance.id)) return
	const secrets = Secrets.forInstance(instance, Registry.dataDir(instance))
	try {
		await fetch(`http://127.0.0.1:${Registry.port(instance)}${DP.EVENT_INGEST_PATH}?${DP.eventToQuery(event)}`, {
			method: 'POST',
			headers: { [DP.SECRET_HEADER]: secrets.proxySecret },
			signal: AbortSignal.timeout(5000),
		})
	} catch (err) {
		log.warn({ err, instanceId: instance.id }, 'could not forward a gateway event')
	}
}

export async function close() {
	await client?.destroy()
	client = undefined
}
