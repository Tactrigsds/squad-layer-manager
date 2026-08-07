import * as Http from 'node:http'
import type * as Net from 'node:net'

import * as Log from './log.ts'
import * as Registry from './registry.ts'
import * as Spawner from './spawner.ts'

// Host-header routing onto the loopback port an instance listens on, plus the two things that fall out of being
// the only thing every request passes through: the activity clock the reaper reads, and wake-on-request.
//
// In-process rather than a second proxy in front, because all three want the registry as their single source of
// truth. A separate router would need its own copy of the mapping and its own way to learn that an instance has
// moved, stopped or been reaped.

let log!: ReturnType<typeof Log.forModule>

export function setup() {
	log = Log.forModule('proxy')
}

export async function ensureAwake(instance: Registry.Instance): Promise<Spawner.StartResult> {
	if (Spawner.isRunning(instance.id) && instance.state === 'running') return { code: 'ok' }
	if (instance.state === 'broken') return { code: 'err:broken' }
	log.info({ instanceId: instance.id }, 'waking %s on request', Registry.host(instance))
	return await Spawner.start(instance)
}

export function forwardHttp(req: Http.IncomingMessage, res: Http.ServerResponse, instance: Registry.Instance) {
	Registry.touch(instance.id)
	const upstream = Http.request(
		{
			host: '127.0.0.1',
			port: Registry.port(instance),
			method: req.method,
			path: req.url,
			headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' },
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
			upstreamRes.pipe(res)
		},
	)
	upstream.on('error', (err) => {
		log.warn({ err, instanceId: instance.id }, 'upstream error for %s', Registry.host(instance))
		if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
		res.end('The demo instance is not responding.')
	})
	// a client that hangs up mid-download otherwise leaves the instance writing a response to nobody, and the app
	// has several endpoints large enough for that to matter
	res.on('close', () => upstream.destroy())
	req.pipe(upstream)
}

// A raw socket splice rather than a second http parse: the app's only upgrade is its orpc websocket, and nothing
// here has any business reading the frames.
export function forwardUpgrade(req: Http.IncomingMessage, socket: Net.Socket, head: Buffer, instance: Registry.Instance) {
	Registry.touch(instance.id)
	const upstream = Http.request({
		host: '127.0.0.1',
		port: Registry.port(instance),
		method: req.method,
		path: req.url,
		headers: req.headers,
	})
	upstream.end()

	upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
		const statusLine = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`]
		for (const [key, value] of Object.entries(upstreamRes.headers)) {
			for (const one of Array.isArray(value) ? value : [value]) statusLine.push(`${key}: ${one}`)
		}
		socket.write(statusLine.join('\r\n') + '\r\n\r\n')
		if (upstreamHead?.length) socket.unshift(upstreamHead)
		if (head?.length) upstreamSocket.write(head)

		// A parked browser tab therefore holds its instance open, which is the intent: the socket is a person with
		// the page in front of them. The ephemeral hard lifetime cap is what bounds it.
		socket.on('data', () => Registry.touch(instance.id))

		const destroy = () => {
			socket.destroy()
			upstreamSocket.destroy()
		}
		socket.on('error', destroy)
		upstreamSocket.on('error', destroy)
		socket.pipe(upstreamSocket)
		upstreamSocket.pipe(socket)
	})

	upstream.on('error', (err) => {
		log.warn({ err, instanceId: instance.id }, 'upgrade failed for %s', Registry.host(instance))
		socket.destroy()
	})
}
