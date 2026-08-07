import * as Http from 'node:http'
import type * as Net from 'node:net'

import * as ControlEnv from './env.ts'
import * as GuildApi from './guild-api.ts'
import * as HttpUtil from './http-util.ts'
import * as Log from './log.ts'
import * as Pages from './pages.ts'
import * as Portal from './portal.ts'
import * as Proxy from './proxy.ts'
import * as Registry from './registry.ts'

// The one port Caddy forwards to. Everything the fleet answers is behind it: the apex portal, an instance's own
// host, and the guild-scoped discord api instances call back into over loopback.

let log!: ReturnType<typeof Log.forModule>
let server: Http.Server | undefined

// instances reach the control plane on loopback rather than through the apex, so this prefix is matched before
// any host routing
const FLEET_API_PREFIX = '/_fleet/'

type Route =
	| { code: 'fleet-api' }
	| { code: 'apex' }
	| { code: 'instance'; instance: Registry.Instance }
	| { code: 'unknown-host' }
	| { code: 'no-such-instance' }

export function resolve(hostHeader: string | undefined, pathname: string): Route {
	if (pathname.startsWith(FLEET_API_PREFIX)) return { code: 'fleet-api' }

	const env = ControlEnv.get()
	const host = (hostHeader ?? '').split(':')[0].toLowerCase()
	// the apex is its own host rather than DEMO_BASE_DOMAIN, because a prefixed fleet hangs its instances off a
	// domain whose apex belongs to somebody else
	if (host === env.apexHost || host === `www.${env.apexHost}`) return { code: 'apex' }
	if (!host.endsWith(`.${env.DEMO_BASE_DOMAIN}`)) return { code: 'unknown-host' }

	// the inverse of Registry.host
	const label = host.slice(0, -(env.DEMO_BASE_DOMAIN.length + 1))
	if (!label.startsWith(env.DEMO_HOST_PREFIX)) return { code: 'no-such-instance' }
	const id = label.slice(env.DEMO_HOST_PREFIX.length)
	const instance = id.startsWith('g-') ? Registry.byGuild(id.slice(2)) : id.startsWith('t-') ? Registry.bySlug(id.slice(2)) : undefined
	return instance ? { code: 'instance', instance } : { code: 'no-such-instance' }
}

export function setup() {
	log = Log.forModule('ingress')
	const env = ControlEnv.get()
	server = Http.createServer((req, res) => void onRequest(req, res))
	server.on('upgrade', (req, socket, head) => onUpgrade(req, socket as Net.Socket, head))
	server.listen(env.DEMO_CONTROL_PORT, env.DEMO_CONTROL_HOST)
	log.info(
		'listening on %s:%d, serving %s and %s*.%s',
		env.DEMO_CONTROL_HOST,
		env.DEMO_CONTROL_PORT,
		env.apexHost,
		env.DEMO_HOST_PREFIX,
		env.DEMO_BASE_DOMAIN,
	)
	return server
}

async function onRequest(req: Http.IncomingMessage, res: Http.ServerResponse) {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
	const route = resolve(req.headers.host, url.pathname)
	try {
		switch (route.code) {
			case 'fleet-api':
				return await GuildApi.handle(req, res, url)
			case 'apex':
				return await Portal.handle(req, res, url)
			case 'instance': {
				const awake = await Proxy.ensureAwake(route.instance)
				if (awake.code === 'err:broken') return HttpUtil.sendHtml(res, 503, Pages.broken())
				return Proxy.forwardHttp(req, res, route.instance)
			}
			case 'unknown-host':
			case 'no-such-instance':
				return HttpUtil.sendHtml(res, 404, Pages.notFound())
		}
	} catch (err) {
		log.error({ err, url: req.url, host: req.headers.host }, 'request failed')
		if (!res.headersSent) HttpUtil.sendHtml(res, 500, Pages.error('The demo control plane could not handle that.'))
		else res.end()
	}
}

function onUpgrade(req: Http.IncomingMessage, socket: Net.Socket, head: Buffer) {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
	const route = resolve(req.headers.host, url.pathname)
	if (route.code !== 'instance') {
		socket.destroy()
		return
	}
	void Proxy.ensureAwake(route.instance).then((awake) => {
		if (awake.code === 'err:broken') return socket.destroy()
		Proxy.forwardUpgrade(req, socket, head, route.instance)
	})
}

export async function close() {
	if (!server) return
	await new Promise<void>((resolve) => server!.close(() => resolve()))
}
