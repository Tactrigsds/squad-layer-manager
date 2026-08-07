import * as Crypto from 'node:crypto'
import type * as Http from 'node:http'
import { z } from 'zod'

import * as DemoToken from '@/lib/demo-login-token'

import * as Bot from './bot.ts'
import * as ControlEnv from './env.ts'
import * as HttpUtil from './http-util.ts'
import * as Log from './log.ts'
import * as Pages from './pages.ts'
import * as Registry from './registry.ts'
import * as Secrets from './secrets.ts'
import * as Spawner from './spawner.ts'

// The fleet's single login. Discord caps an application at 10 redirect uris and the fleet has up to 90 hosts, so
// no instance can run an oauth flow of its own. They all bounce here, and what goes back is a token an instance
// can check with a public key rather than a session it would have had to authenticate itself.

export const CALLBACK_PATH = '/login/callback'
// where the portal's "add to your discord server" button goes, and where discord returns from it. Adding the app
// is an oauth flow like any other, so it can hand the installer back to us rather than leaving them to find
// their own way to an instance they just created.
export const INSTALL_PATH = '/install'
export const INSTALLED_PATH = '/installed'

// Manage Guild. Who may choose the instance's full-access role; see the first-login role pick.
const MANAGE_GUILD = 1n << 5n
const ADMINISTRATOR = 1n << 3n

const STATE_TTL_MS = 10 * 60 * 1000

let log!: ReturnType<typeof Log.forModule>

// What an in-flight oauth round trip is for. In memory: the control plane is one process, and a state that does
// not survive a restart costs the handful of people mid-flow a retry. Keyed by kind as well as value so a code
// meant for one flow cannot be spent on the other.
type PendingKind = { kind: 'login'; guildId: string } | { kind: 'install' }
const pendingStates = new Map<string, PendingKind & { createdAt: number }>()

export function setup() {
	log = Log.forModule('broker')
}

function redirectUri(path: string): string {
	return `${ControlEnv.get().apexOrigin}${path}`
}

function mintState(pending: PendingKind): string {
	const now = Date.now()
	for (const [key, existing] of pendingStates) {
		if (now - existing.createdAt > STATE_TTL_MS) pendingStates.delete(key)
	}
	const state = Crypto.randomBytes(24).toString('base64url')
	pendingStates.set(state, { ...pending, createdAt: now })
	return state
}

// Spent whatever it turns out to be for, so a state offered to the wrong endpoint is burned rather than left to
// be tried again at the right one. Callers narrow on `kind`, which is what stops a code minted for one flow being
// redeemed in the other.
function claimState(url: URL): PendingKind | null {
	const state = url.searchParams.get('state')
	const pending = state ? pendingStates.get(state) : undefined
	if (!pending) return null
	pendingStates.delete(state!)
	return pending
}

function authorizeUrl(args: { scope: string; state: string; redirectPath: string; bot: boolean }): string {
	const env = ControlEnv.get()
	const authorize = new URL('https://discord.com/oauth2/authorize')
	authorize.searchParams.set('client_id', env.DEMO_DISCORD_CLIENT_ID!)
	authorize.searchParams.set('redirect_uri', redirectUri(args.redirectPath))
	authorize.searchParams.set('response_type', 'code')
	authorize.searchParams.set('scope', args.scope)
	authorize.searchParams.set('state', args.state)
	// the fleet reads the guild and never posts in it except to say goodbye
	if (args.bot) authorize.searchParams.set('permissions', '0')
	return authorize.toString()
}

export async function startLogin(req: Http.IncomingMessage, res: Http.ServerResponse, url: URL) {
	const env = ControlEnv.get()
	if (!env.guildFlowEnabled) return HttpUtil.sendHtml(res, 404, Pages.notFound())

	const guildId = url.pathname.slice('/go/'.length)
	if (!/^\d+$/.test(guildId) || !Registry.byGuild(guildId)) return HttpUtil.sendHtml(res, 404, Pages.notFound())

	// `guilds` is what makes the membership and permission check possible without the bot reading the member list
	const state = mintState({ kind: 'login', guildId })
	HttpUtil.redirect(res, authorizeUrl({ scope: 'identify guilds', state, redirectPath: CALLBACK_PATH, bot: false }))
}

// The install link itself, rather than a discord url the portal builds. It exists so the flow can carry a state
// parameter: an install link gets shared around, and a bare discord authorize url has nowhere to put one.
export async function startInstall(req: Http.IncomingMessage, res: Http.ServerResponse, _url: URL) {
	const env = ControlEnv.get()
	if (!env.guildFlowEnabled) return HttpUtil.sendHtml(res, 404, Pages.notFound())

	const state = mintState({ kind: 'install' })
	HttpUtil.redirect(res, authorizeUrl({ scope: 'bot identify guilds', state, redirectPath: INSTALLED_PATH, bot: true }))
}

const TokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string(),
	// present only on a grant that included the `bot` scope, and the only thing that says which server the app
	// was just added to. Optional because the install flow degrades to the gateway's own provisioning without it.
	guild: z.object({ id: z.string(), name: z.string() }).optional(),
})
const UserSchema = z.object({ id: z.string(), username: z.string() })
const UserGuildSchema = z.object({ id: z.string(), permissions: z.string() })

type Identity = { discordId: string; username: string; canConfigure: boolean }

// Who this is, and whether they may configure the instance for the guild named. Measured against the guild rather
// than assumed from context: adding an app already requires Manage Server, but a permission that grants the
// first-login role pick is worth reading rather than inferring.
async function identify(token: z.infer<typeof TokenResponseSchema>, guildId: string): Promise<Identity | 'err:api' | 'err:not-a-member'> {
	const user = await getJson(UserSchema, 'https://discord.com/api/users/@me', token)
	const guilds = await getJson(z.array(UserGuildSchema), 'https://discord.com/api/users/@me/guilds', token)
	if (!user || !guilds) return 'err:api'

	const membership = guilds.find((guild) => guild.id === guildId)
	if (!membership) {
		log.warn({ discordId: user.id, guildId }, 'oauth flow completed for a guild the user is not in')
		return 'err:not-a-member'
	}
	const permissions = BigInt(membership.permissions)
	return {
		discordId: user.id,
		username: user.username,
		canConfigure: (permissions & MANAGE_GUILD) !== 0n || (permissions & ADMINISTRATOR) !== 0n,
	}
}

// Minted immediately before the redirect and good for 60 seconds, so nothing slow may happen between here and
// the instance receiving it.
function loginRedirect(res: Http.ServerResponse, instance: Registry.Instance, identity: Identity, guildId: string) {
	const minted = DemoToken.sign(Secrets.getBrokerKeys().privateKey, {
		guildId,
		discordId: identity.discordId,
		username: identity.username,
		canConfigure: identity.canConfigure,
	})
	HttpUtil.redirect(res, `${Registry.origin(instance)}/login/token?t=${encodeURIComponent(minted)}`)
}

export async function completeLogin(req: Http.IncomingMessage, res: Http.ServerResponse, url: URL) {
	const env = ControlEnv.get()
	if (!env.guildFlowEnabled) return HttpUtil.sendHtml(res, 404, Pages.notFound())

	const code = url.searchParams.get('code')
	const pending = claimState(url)
	if (!code || pending?.kind !== 'login') return HttpUtil.sendHtml(res, 400, Pages.error('That login link has expired. Start again.'))

	const instance = Registry.byGuild(pending.guildId)
	if (!instance) return HttpUtil.sendHtml(res, 404, Pages.notFound())

	const token = await exchangeCode(code, CALLBACK_PATH)
	if (!token) return HttpUtil.sendHtml(res, 502, Pages.error('Discord would not complete the login.'))

	const identity = await identify(token, pending.guildId)
	if (identity === 'err:api') return HttpUtil.sendHtml(res, 502, Pages.error('Discord would not say who you are.'))
	if (identity === 'err:not-a-member') {
		return HttpUtil.sendHtml(res, 403, Pages.error('You are not a member of the Discord server this demo belongs to.'))
	}

	loginRedirect(res, instance, identity, pending.guildId)
}

// Adding the app and reaching the instance it creates used to be two disconnected acts joined by a DM to the
// server's owner, who is not necessarily the person who installed it and may not accept DMs at all. Coming back
// through here closes that: the installer lands signed in on their own instance, and Discord has already proved
// they hold Manage Server by letting them add the app.
export async function completeInstall(req: Http.IncomingMessage, res: Http.ServerResponse, url: URL) {
	const env = ControlEnv.get()
	if (!env.guildFlowEnabled) return HttpUtil.sendHtml(res, 404, Pages.notFound())

	const code = url.searchParams.get('code')
	const pending = claimState(url)
	// the usual cause is a bounced-on install link rather than anything wrong; the app is added either way, so
	// send them somewhere useful
	if (!code || pending?.kind !== 'install') return HttpUtil.redirect(res, env.apexOrigin + '/')

	const token = await exchangeCode(code, INSTALLED_PATH)
	if (!token) return HttpUtil.sendHtml(res, 502, Pages.error('Discord would not complete the install.'))
	if (!token.guild) {
		// nothing is lost: the gateway's GUILD_CREATE provisions the instance and messages the owner regardless.
		// This path is the improvement on that, not a replacement for it.
		log.warn('the install grant carried no guild; falling back to the gateway path')
		return HttpUtil.redirect(res, env.apexOrigin + '/')
	}

	const guildId = token.guild.id
	const provisioned = Bot.ensureProvisioned(guildId)
	if (provisioned.code === 'err:at-capacity') return HttpUtil.sendHtml(res, 503, Pages.atCapacity('guild'))

	const identity = await identify(token, guildId)
	if (identity === 'err:api' || identity === 'err:not-a-member') {
		log.warn({ guildId, reason: identity }, 'could not identify an installer; sending them to the portal')
		return HttpUtil.redirect(res, env.apexOrigin + '/')
	}

	// awaited rather than backgrounded: the login token below is good for a minute, and handing it to a browser
	// that then has to wait out a cold boot is how it expires in flight
	const started = await Spawner.start(provisioned.instance)
	if (started.code === 'err:start-failed') return HttpUtil.sendHtml(res, 503, Pages.startFailed())
	if (started.code === 'err:broken') return HttpUtil.sendHtml(res, 503, Pages.broken())

	log.info({ guildId, discordId: identity.discordId, guildName: token.guild.name }, 'installer landed on their new instance')
	loginRedirect(res, provisioned.instance, identity, guildId)
}

async function exchangeCode(code: string, redirectPath: string) {
	const env = ControlEnv.get()
	try {
		const response = await fetch('https://discord.com/api/oauth2/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: env.DEMO_DISCORD_CLIENT_ID!,
				client_secret: env.DEMO_DISCORD_CLIENT_SECRET!,
				grant_type: 'authorization_code',
				code,
				// discord requires this to match the authorize request's, so the two flows cannot share one
				redirect_uri: redirectUri(redirectPath),
			}),
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) {
			log.warn('discord refused the code exchange: %d', response.status)
			return null
		}
		return TokenResponseSchema.parse(await response.json())
	} catch (err) {
		log.error({ err }, 'the code exchange failed')
		return null
	}
}

async function getJson<T extends z.ZodType>(
	schema: T,
	url: string,
	token: z.infer<typeof TokenResponseSchema>,
): Promise<z.infer<T> | null> {
	try {
		const response = await fetch(url, {
			headers: { Authorization: `${token.token_type} ${token.access_token}` },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) return null
		return schema.parse(await response.json())
	} catch (err) {
		log.error({ err, url }, 'a discord api call failed')
		return null
	}
}
