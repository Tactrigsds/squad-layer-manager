import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import * as Env from './env.ts'
import type * as SecretBoxModule from './secret-box.server.ts'

let SecretBox: typeof SecretBoxModule

beforeAll(async () => {
	Env.ensureEnvSetup()
	Env.injectRawVar('SETTINGS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
	SecretBox = await import('./secret-box.server.ts')
	SecretBox.setup()
})

describe('secret-box', () => {
	it('round-trips a value through seal/open', () => {
		const secret = 'super-secret-rcon-password'
		const sealed = SecretBox.seal(secret)
		expect(sealed.startsWith('enc:v1:')).toBe(true)
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

describe('SETTINGS_ENCRYPTION_KEY validation', () => {
	const schema = Env.groups.encryption.SETTINGS_ENCRYPTION_KEY
	it('accepts a base64-encoded 32-byte key', () => {
		expect(schema.safeParse(randomBytes(32).toString('base64')).success).toBe(true)
	})
	it('rejects a key that is not 32 bytes', () => {
		expect(schema.safeParse(randomBytes(16).toString('base64')).success).toBe(false)
	})
	it('rejects an empty key', () => {
		expect(schema.safeParse('').success).toBe(false)
	})
})
