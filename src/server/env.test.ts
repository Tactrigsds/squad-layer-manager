import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ensureEnvSetup latches, so each case gets a fresh module registry and a fresh copy of the environment
async function loadEnv(secrets: string | undefined, env: Record<string, string> = {}) {
	vi.resetModules()
	let secretsPath: string | undefined
	if (secrets !== undefined) {
		secretsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slm-env-')), '.env.secrets')
		fs.writeFileSync(secretsPath, secrets)
	}
	// always explicit: the default path is the repo root, which may or may not have a real one sitting in it
	process.env.SECRETS_FILE = secretsPath ?? path.join(os.tmpdir(), 'slm-no-such-secrets')
	Object.assign(process.env, env)
	return await import('./env.ts')
}

const KEY = 'A'.repeat(44)
const originalEnv = { ...process.env }

beforeEach(() => {
	process.env = { ...originalEnv, NODE_ENV: 'test' }
})

afterEach(() => {
	process.env = { ...originalEnv }
})

describe('secrets', () => {
	it('reads them from the secrets file without putting them in the environment', async () => {
		const Env = await loadEnv(`DISCORD_BOT_TOKEN=from-file\nSETTINGS_ENCRYPTION_KEY=${KEY}\n`)
		Env.ensureEnvSetup()

		expect(Env.rawVar('DISCORD_BOT_TOKEN')).toBe('from-file')
		expect(Env.rawVar('SETTINGS_ENCRYPTION_KEY')).toBe(KEY)
		// the point of the file: a credential that was never in the environment can't be read back out of it
		expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined()
		expect(process.env.SETTINGS_ENCRYPTION_KEY).toBeUndefined()
		expect(Object.values(process.env)).not.toContain('from-file')
	})

	// an install predating the split, and the test harness, both hand them over this way
	it('still reads one passed through the environment, and takes it back out', async () => {
		const Env = await loadEnv('', { BM_PAT: 'from-environment' })
		Env.ensureEnvSetup()

		expect(Env.rawVar('BM_PAT')).toBe('from-environment')
		expect(process.env.BM_PAT).toBeUndefined()
	})

	it('leaves everything that is not a credential in the environment', async () => {
		const Env = await loadEnv('', { ORIGIN: 'http://example.com:3000' })
		Env.ensureEnvSetup()

		expect(Env.rawVar('ORIGIN')).toBe('http://example.com:3000')
		expect(process.env.ORIGIN).toBe('http://example.com:3000')
	})

	it('prefers the file over the environment', async () => {
		const Env = await loadEnv('BM_PAT=from-file\n', { BM_PAT: 'from-environment' })
		Env.ensureEnvSetup()

		expect(Env.rawVar('BM_PAT')).toBe('from-file')
	})

	// booting without the secrets someone pointed us at is never what they meant
	it('refuses to boot when SECRETS_FILE names a file that is not there', async () => {
		const Env = await loadEnv(undefined)
		expect(() => Env.ensureEnvSetup()).toThrow(/Could not read the secrets file/)
	})

	it('boots without a secrets file when none was asked for', async () => {
		vi.resetModules()
		delete process.env.SECRETS_FILE
		const Env = await import('./env.ts')
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})
})
