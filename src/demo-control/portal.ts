import * as Crypto from 'node:crypto'
import type * as Http from 'node:http'

import * as ZodUtils from '@/lib/zod-utils'

import * as Broker from './broker.ts'
import * as ControlEnv from './env.ts'
import * as HttpUtil from './http-util.ts'
import * as Log from './log.ts'
import * as Pages from './pages.ts'
import * as Registry from './registry.ts'
import * as Spawner from './spawner.ts'

// Everything the apex host answers: the landing page, the "try it now" mint, the login broker's two routes, and
// the fleet status page.

const INSTANCE_COOKIE = 'demo-instance'

let log!: ReturnType<typeof Log.forModule>

export function setup() {
	log = Log.forModule('portal')
}

// A slug nobody can guess is the whole access control on an ephemeral instance: there is no login on one, so the
// url is the secret. 16 bytes, lowercase base36-ish via base64url.
function mintSlug(): string {
	return Crypto.randomBytes(12)
		.toString('base64url')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
}

function instanceUrl(instance: Registry.Instance): string {
	return `${Registry.origin(instance)}/`
}

// Per-address mint budget, in memory: the control plane is one process, and a limit that does not survive a
// restart is a limit that is briefly generous rather than one that is absent.
const HOUR_MS = 60 * 60 * 1000
const mintsByAddress = new Map<string, number[]>()
function withinRateLimit(address: string, now = Date.now()): boolean {
	const hourly = ControlEnv.get().DEMO_EPHEMERAL_PER_IP_HOURLY
	// swept here rather than on a timer: nothing else looks at this map, so the only moment an address can be
	// known to be spent is the next time one is checked
	for (const [key, times] of mintsByAddress) {
		if (times.every((at) => now - at >= HOUR_MS)) mintsByAddress.delete(key)
	}
	const recent = (mintsByAddress.get(address) ?? []).filter((at) => now - at < HOUR_MS)
	mintsByAddress.set(address, recent)
	if (recent.length >= hourly) return false
	recent.push(now)
	return true
}

// Ours rather than a discord url built here, so the flow can carry a state parameter and so discord has somewhere
// to return the installer to. See broker.startInstall.
function installUrl(): string | null {
	const env = ControlEnv.get()
	if (!env.guildFlowEnabled) return null
	return `${env.apexOrigin}${Broker.INSTALL_PATH}`
}

export async function handle(req: Http.IncomingMessage, res: Http.ServerResponse, url: URL): Promise<void> {
	if (req.method === 'POST' && url.pathname === '/try') return await mintEphemeral(req, res)
	if (url.pathname === '/fleet') return fleetStatus(res, url)
	if (url.pathname.startsWith('/go/')) return await Broker.startLogin(req, res, url)
	if (url.pathname === Broker.CALLBACK_PATH) return await Broker.completeLogin(req, res, url)
	if (url.pathname === Broker.INSTALL_PATH) return await Broker.startInstall(req, res, url)
	if (url.pathname === Broker.INSTALLED_PATH) return await Broker.completeInstall(req, res, url)
	if (url.pathname === '/') return landing(req, res)
	HttpUtil.sendHtml(res, 404, Pages.notFound())
}

function landing(req: Http.IncomingMessage, res: Http.ServerResponse) {
	const held = HttpUtil.cookies(req)[INSTANCE_COOKIE]
	const existing = held ? Registry.byId(held) : undefined
	HttpUtil.sendHtml(
		res,
		200,
		Pages.landing({
			installUrl: installUrl(),
			existingInstanceUrl: existing && existing.kind === 'ephemeral' ? instanceUrl(existing) : null,
		}),
	)
}

async function mintEphemeral(req: Http.IncomingMessage, res: Http.ServerResponse) {
	// the cookie is the difference between a reload and a second instance, so it is checked before the rate limit
	const held = HttpUtil.cookies(req)[INSTANCE_COOKIE]
	const existing = held ? Registry.byId(held) : undefined
	if (existing?.kind === 'ephemeral') return HttpUtil.redirect(res, instanceUrl(existing))

	const address = HttpUtil.clientAddress(req)
	if (!withinRateLimit(address)) {
		log.warn({ address }, 'rate-limited an ephemeral mint')
		return HttpUtil.sendHtml(res, 429, Pages.rateLimited())
	}

	const created = Registry.create({ kind: 'ephemeral', slug: mintSlug() })
	switch (created.code) {
		case 'err:at-capacity':
			return HttpUtil.sendHtml(res, 503, Pages.atCapacity('ephemeral'))
		case 'err:exists':
			// two mints collided on a slug, which is not worth a retry loop
			return HttpUtil.sendHtml(res, 500, Pages.error('Could not allocate a demo. Try again.'))
		case 'ok':
			break
	}

	const url = instanceUrl(created.instance)
	const cookie = HttpUtil.setCookie(INSTANCE_COOKIE, created.instance.id, Math.floor(ControlEnv.get().DEMO_EPHEMERAL_MAX_LIFETIME / 1000))
	// the boot is the slow part, and holding the POST open for it looks like a hang. The interstitial refreshes
	// into an instance the proxy would wake anyway.
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': cookie })
	res.end(Pages.starting(url))
	void Spawner.start(created.instance)
}

// An ephemeral instance's slug is its only access control, so this page never prints one, and it is not reachable
// at all without the token. Unset means there is no fleet page, rather than an open one.
function fleetStatus(res: Http.ServerResponse, url: URL) {
	const token = ControlEnv.get().DEMO_FLEET_TOKEN
	if (!token || url.searchParams.get('token') !== token) return HttpUtil.sendHtml(res, 404, Pages.notFound())
	const now = Date.now()
	const rows = Registry.all().map((instance) => ({
		host: instance.kind === 'guild' ? Registry.host(instance) : `t-${instance.id}`,
		kind: instance.kind,
		state: Spawner.isRunning(instance.id) ? instance.state : `${instance.state} (no process)`,
		idleFor: ZodUtils.formatHumanTime(now - instance.lastActiveAt),
		age: ZodUtils.formatHumanTime(now - instance.createdAt),
	}))
	HttpUtil.sendHtml(res, 200, Pages.fleetStatus(rows))
}
