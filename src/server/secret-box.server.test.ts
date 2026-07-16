import { createCipheriv, randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import * as Env from './env.ts'
import type * as SecretBoxModule from './secret-box.server.ts'

let SecretBox: typeof SecretBoxModule
const KEY = randomBytes(32).toString('base64')

// an envelope as it was written before the key became a hash of the key value: the same cipher, keyed by the
// key value base64-decoded
function sealV1(plaintext: string, keyValue = KEY) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyValue, 'base64'), iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

beforeAll(async () => {
	Env.ensureEnvSetup()
	Env.injectRawVar('SETTINGS_ENCRYPTION_KEY', KEY)
	SecretBox = await import('./secret-box.server.ts')
	SecretBox.setup()
})

describe('secret-box', () => {
	it('round-trips a value through seal/open', () => {
		const secret = 'super-secret-rcon-password'
		const sealed = SecretBox.seal(secret)
		expect(sealed.startsWith('enc:v2:')).toBe(true)
		expect(sealed).not.toContain(secret)
		expect(SecretBox.open(sealed)).toBe(secret)
	})

	it('produces a fresh ciphertext each time (random iv)', () => {
		expect(SecretBox.seal('x')).not.toBe(SecretBox.seal('x'))
	})

	it('is idempotent: sealing an already-sealed value is a no-op', () => {
		const sealed = SecretBox.seal('token')
		expect(SecretBox.seal(sealed)).toBe(sealed)
	})

	it('passes legacy plaintext through open unchanged', () => {
		expect(SecretBox.open('legacy-plaintext-password')).toBe('legacy-plaintext-password')
	})

	it('rejects a tampered envelope', () => {
		const sealed = SecretBox.seal('secret')
		const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA')
		expect(() => SecretBox.open(tampered)).toThrow()
	})

	it('reports whether a value is sealed', () => {
		expect(SecretBox.isSealed(SecretBox.seal('a'))).toBe(true)
		expect(SecretBox.isSealed('a')).toBe(false)
	})
})

// the key derivation changed from "base64-decode the value" to "sha256 the value", which left every existing
// envelope unreadable by the key that sealed it. v1 envelopes are still opened with the old derivation so an
// install that has them can re-seal rather than re-enter every secret by hand.
describe('secret-box v1 envelopes', () => {
	it('opens a v1 envelope sealed with the legacy key derivation', () => {
		expect(SecretBox.open(sealV1('legacy-rcon-password'))).toBe('legacy-rcon-password')
	})

	it('counts a v1 envelope as sealed, but as needing a reseal', () => {
		const v1 = sealV1('token')
		expect(SecretBox.isSealed(v1)).toBe(true)
		expect(SecretBox.needsReseal(v1)).toBe(true)
	})

	it('reseals a v1 envelope to v2, preserving the secret', () => {
		const resealed = SecretBox.reseal(sealV1('rcon-password'))
		expect(resealed.startsWith('enc:v2:')).toBe(true)
		expect(SecretBox.open(resealed)).toBe('rcon-password')
		expect(SecretBox.needsReseal(resealed)).toBe(false)
	})

	it('needs a reseal for plaintext, not for a current envelope', () => {
		expect(SecretBox.needsReseal('plaintext-password')).toBe(true)
		expect(SecretBox.needsReseal(SecretBox.seal('x'))).toBe(false)
	})

	it('explains itself when a value was sealed with a genuinely different key', () => {
		const otherKey = randomBytes(32).toString('base64')
		expect(() => SecretBox.open(sealV1('secret', otherKey))).toThrow(/different SETTINGS_ENCRYPTION_KEY/)
	})
})

describe('SETTINGS_ENCRYPTION_KEY', () => {
	const schema = Env.groups.encryption.SETTINGS_ENCRYPTION_KEY
	it('turns any string into the 32 bytes the cipher needs', () => {
		for (const key of [randomBytes(32).toString('base64'), 'A_VERY_INSECURE_ENCRYPTION_KEY', 'x']) {
			const parsed = schema.parse(key)
			expect(parsed).toHaveLength(32)
		}
	})
	// a key that changed shape between boots would leave every sealed setting unreadable
	it('derives the same key from the same string every time', () => {
		expect(schema.parse('a-passphrase')).toEqual(schema.parse('a-passphrase'))
		expect(schema.parse('a-passphrase')).not.toEqual(schema.parse('another-passphrase'))
	})
	it('rejects an empty key', () => {
		expect(schema.safeParse('').success).toBe(false)
	})
})
