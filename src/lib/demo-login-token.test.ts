import { describe, expect, it } from 'vitest'

import * as DemoToken from './demo-login-token'

const PAYLOAD = { guildId: '123456789012345678', discordId: '987654321098765432', username: 'someone', canConfigure: true }

describe('demo login token', () => {
	const keys = DemoToken.generateKeypair()
	const publicKey = DemoToken.importPublic(keys.publicKey)

	it('round-trips what the broker signed', () => {
		const res = DemoToken.verify(publicKey, DemoToken.sign(keys.privateKey, PAYLOAD))
		expect(res.code).toBe('ok')
		if (res.code !== 'ok') return
		expect(res.payload).toMatchObject(PAYLOAD)
	})

	it('derives the public key the instance is handed from the private one the broker keeps', () => {
		expect(DemoToken.publicKeyFor(keys.privateKey)).toBe(keys.publicKey)
	})

	it('rejects a token another keypair signed', () => {
		const impostor = DemoToken.generateKeypair()
		expect(DemoToken.verify(publicKey, DemoToken.sign(impostor.privateKey, PAYLOAD)).code).toBe('err:bad-signature')
	})

	// the payload is signed rather than sealed, so it is readable; what must not be possible is changing it
	it('rejects a token whose payload was edited', () => {
		const [body, signature] = DemoToken.sign(keys.privateKey, PAYLOAD).split('.')
		const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
		const tampered = Buffer.from(JSON.stringify({ ...decoded, canConfigure: true, guildId: '1' })).toString('base64url')
		expect(DemoToken.verify(publicKey, `${tampered}.${signature}`).code).toBe('err:bad-signature')
	})

	it('rejects a token past its expiry', () => {
		const now = 1_700_000_000_000
		const token = DemoToken.sign(keys.privateKey, PAYLOAD, now)
		expect(DemoToken.verify(publicKey, token, now + DemoToken.TTL_MS - 1).code).toBe('ok')
		expect(DemoToken.verify(publicKey, token, now + DemoToken.TTL_MS).code).toBe('err:expired')
	})

	it.each(['', 'nodot', 'a.b', '.', 'x.'])('rejects the malformed token %j', (token) => {
		expect(['err:malformed', 'err:bad-signature']).toContain(DemoToken.verify(publicKey, token).code)
	})

	it('mints a fresh nonce per token, so two logins never collide', () => {
		const nonces = Array.from({ length: 50 }, () => {
			const res = DemoToken.verify(publicKey, DemoToken.sign(keys.privateKey, PAYLOAD))
			return res.code === 'ok' ? res.payload.nonce : 'not-ok'
		})
		expect(new Set(nonces).size).toBe(50)
	})

	describe('nonce set', () => {
		it('spends a nonce once', () => {
			const seen = new DemoToken.NonceSet()
			expect(seen.claim('abc', Date.now() + 1000)).toBe(true)
			expect(seen.claim('abc', Date.now() + 1000)).toBe(false)
		})

		// a nonce cannot be replayed after its token expires either, but it no longer has to be remembered to
		// stop it: the expiry check has already rejected the token by then
		it('forgets nonces past their expiry rather than growing forever', () => {
			const seen = new DemoToken.NonceSet()
			expect(seen.claim('abc', 1000, 0)).toBe(true)
			expect(seen.claim('def', 5000, 2000)).toBe(true)
			expect(seen.claim('abc', 6000, 2000)).toBe(true)
		})
	})
})
