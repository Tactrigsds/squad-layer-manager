import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// for the var metadata only; each case imports its own instance through loadEnv
import * as Env from './env.ts'

// ensureEnvSetup latches, so each case gets a fresh module registry and a fresh copy of the environment
async function loadEnv(secrets: string | undefined, env: Record<string, string> = {}) {
	vi.resetModules()
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-env-'))
	let secretsPath: string | undefined
	if (secrets !== undefined) {
		secretsPath = path.join(dir, '.env.secrets')
		fs.writeFileSync(secretsPath, secrets)
	}
	// ensureEnvSetup loads the .env into the environment, and the repo root has a real one with real secrets in
	// it on any machine the app has been run on. Point it at an empty file so a case only ever sees what it sets.
	const envPath = path.join(dir, '.env')
	fs.writeFileSync(envPath, '')
	vi.doMock('../systems/cli.server', () => ({ options: { envFile: envPath } }))
	// always explicit: the default path is the repo root, which may or may not have a real one sitting in it
	process.env.SECRETS_FILE = secretsPath ?? path.join(os.tmpdir(), 'slm-no-such-secrets')
	Object.assign(process.env, env)
	return await import('./env.ts')
}

const KEY = 'A'.repeat(44)
const originalEnv = { ...process.env }

// The setup file imports a module that calls ensureEnvSetup at import time, which loads the repo root's .env
// into the environment before this file is even evaluated -- so originalEnv already holds whatever real
// credentials the machine has. Drop everything env.ts reads, so a case only sees what it sets itself.
function baseEnv() {
	const env = { ...originalEnv }
	for (const [key] of Env.entries()) delete env[key]
	return { ...env, NODE_ENV: 'test' }
}

beforeEach(() => {
	process.env = baseEnv()
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
		expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined()
		expect(Object.values(process.env)).not.toContain('from-file')
		expect(Env.getSecretsFromEnvironment()).toEqual([])
	})

	// an install predating the split, and the test harness, both hand them over this way
	it('still reads one passed through the environment, and reports it', async () => {
		const Env = await loadEnv('', { BM_PAT: 'from-environment' })
		Env.ensureEnvSetup()

		expect(Env.rawVar('BM_PAT')).toBe('from-environment')
		expect(Env.getSecretsFromEnvironment()).toEqual(['BM_PAT'])
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
		expect(Env.getSecretsFromEnvironment()).toEqual([])
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

describe('the development encryption key', () => {
	it('is refused in production, where it would encrypt nothing: it is public', async () => {
		const { INSECURE_DEV_ENCRYPTION_KEY } = await import('./env.ts')
		const Env = await loadEnv(`SETTINGS_ENCRYPTION_KEY=${INSECURE_DEV_ENCRYPTION_KEY}\n`, { NODE_ENV: 'production' })
		expect(() => Env.ensureEnvSetup()).toThrow(/development key/)
	})

	it('is fine outside production, which is the whole point of shipping it', async () => {
		const { INSECURE_DEV_ENCRYPTION_KEY } = await import('./env.ts')
		const Env = await loadEnv(`SETTINGS_ENCRYPTION_KEY=${INSECURE_DEV_ENCRYPTION_KEY}\n`)
		expect(() => Env.ensureEnvSetup()).not.toThrow()
		expect(Env.rawVar('SETTINGS_ENCRYPTION_KEY')).toBe(INSECURE_DEV_ENCRYPTION_KEY)
	})

	it('does not stop production booting with a real key', async () => {
		const Env = await loadEnv(`SETTINGS_ENCRYPTION_KEY=${KEY}\n`, { NODE_ENV: 'production' })
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})
})
