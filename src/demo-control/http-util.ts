import Cookie from 'cookie'
import type * as Http from 'node:http'

import * as ControlEnv from './env.ts'

export function sendHtml(res: Http.ServerResponse, status: number, html: string) {
	res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
	res.end(html)
}

export function sendJson(res: Http.ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
	res.end(JSON.stringify(body))
}

export function redirect(res: Http.ServerResponse, location: string, setCookie?: string) {
	const headers: Http.OutgoingHttpHeaders = { location, 'cache-control': 'no-store' }
	if (setCookie) headers['set-cookie'] = setCookie
	res.writeHead(302, headers)
	res.end()
}

export function cookies(req: Http.IncomingMessage): Record<string, string | undefined> {
	return req.headers.cookie ? Cookie.parse(req.headers.cookie) : {}
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
	return Cookie.serialize(name, value, { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: maxAgeSeconds })
}

// The address a mint is rate-limited against. Which header can be believed is a fact about what is deployed in
// front of the fleet, not about the fleet, so it is named by DEMO_CLIENT_IP_HEADER and defaults to nothing.
//
// Guessing here is worse than not trying: behind two hops the rightmost x-forwarded-for entry is the inner
// proxy's own address, so every visitor would share one bucket and the third mint of the hour would be refused
// for everybody. The leftmost is whatever the client claimed. Both are wrong without knowing the deployment.
export function clientAddress(req: Http.IncomingMessage): string {
	const header = ControlEnv.get().DEMO_CLIENT_IP_HEADER
	if (header) {
		const raw = req.headers[header]
		const value = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim()
		if (value) return value
	}
	return req.socket.remoteAddress || 'unknown'
}

export async function readBody(req: Http.IncomingMessage, limit = 64 * 1024): Promise<Buffer> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > limit) throw new Error('request body too large')
		chunks.push(chunk as Buffer)
	}
	return Buffer.concat(chunks)
}
