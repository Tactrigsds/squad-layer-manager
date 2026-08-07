import * as Crypto from 'node:crypto'
import { z } from 'zod'

// The bearer the demo fleet's login broker mints and a demo instance accepts. The broker holds the discord oauth
// app (one apex redirect uri for the whole fleet, since discord caps an app at 10) and the instance holds nothing:
// it only has to be able to tell that this signature came from the broker, which a public key is enough for.
//
// Both sides of the wire live here so the payload can never drift between them.

export const TTL_MS = 60_000

export const PayloadSchema = z.object({
	// snowflakes as strings: they cross a JSON boundary
	guildId: z.string().min(1),
	discordId: z.string().min(1),
	username: z.string().min(1),
	// holds Manage Guild, which is who may choose the instance's full-access role
	canConfigure: z.boolean(),
	// epoch ms
	exp: z.number().int(),
	nonce: z.string().min(1),
})
export type Payload = z.infer<typeof PayloadSchema>

export type Keypair = { privateKey: string; publicKey: string }

// DER rather than PEM on both sides: these travel as an env var and a file line, and PEM's newlines survive
// neither reliably.
export function generateKeypair(): Keypair {
	const { privateKey, publicKey } = Crypto.generateKeyPairSync('ed25519')
	return {
		privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
		publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
	}
}

function importPrivate(key: string) {
	return Crypto.createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' })
}

export function importPublic(key: string) {
	return Crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
}

export function publicKeyFor(privateKey: string): string {
	return Crypto.createPublicKey(importPrivate(privateKey)).export({ type: 'spki', format: 'der' }).toString('base64')
}

export function sign(privateKey: string, payload: Omit<Payload, 'exp' | 'nonce'>, now = Date.now()): string {
	const full: Payload = { ...payload, exp: now + TTL_MS, nonce: Crypto.randomBytes(16).toString('base64url') }
	const body = Buffer.from(JSON.stringify(full)).toString('base64url')
	const signature = Crypto.sign(null, Buffer.from(body), importPrivate(privateKey)).toString('base64url')
	return `${body}.${signature}`
}

export type VerifyResult =
	| { code: 'ok'; payload: Payload }
	| { code: 'err:malformed' }
	| { code: 'err:bad-signature' }
	| { code: 'err:expired' }

export function verify(publicKey: Crypto.KeyObject, token: string, now = Date.now()): VerifyResult {
	const [body, signature] = token.split('.')
	if (!body || !signature) return { code: 'err:malformed' }

	let verified: boolean
	try {
		verified = Crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(signature, 'base64url'))
	} catch {
		return { code: 'err:malformed' }
	}
	if (!verified) return { code: 'err:bad-signature' }

	let parsed: unknown
	try {
		parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
	} catch {
		return { code: 'err:malformed' }
	}
	const payload = PayloadSchema.safeParse(parsed)
	if (!payload.success) return { code: 'err:malformed' }
	if (payload.data.exp <= now) return { code: 'err:expired' }
	return { code: 'ok', payload: payload.data }
}

// Every token is single-use. The set is in-memory because an instance is a single process which the control plane
// restarts with an empty one, and a token outlives its own TTL by nothing.
export class NonceSet {
	private seen = new Map<string, number>()

	// false when this nonce has already been spent
	claim(nonce: string, expiresAt: number, now = Date.now()): boolean {
		for (const [key, exp] of this.seen) {
			if (exp <= now) this.seen.delete(key)
		}
		if (this.seen.has(nonce)) return false
		this.seen.set(nonce, expiresAt)
		return true
	}
}
