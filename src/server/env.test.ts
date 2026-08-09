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

describe('DEMO', () => {
	it('needs nothing else set', async () => {
		const Env = await loadEnv('', { DEMO: '1' })
		expect(() => Env.ensureEnvSetup()).not.toThrow()

		expect(Env.rawVar('QUERY_PARAM_AUTH_BYPASS')).toBe('true')
		expect(Env.rawVar('DISCORD_ENABLED')).toBe('false')
	})

	// the credentials would sit unused while the login portal signs anyone in as anyone
	it('refuses to boot alongside credentials for an integration still switched on', async () => {
		const Env = await loadEnv('DISCORD_CLIENT_SECRET=real-secret\n', { DEMO: '1', DISCORD_CLIENT_ID: 'real-id' })
		expect(() => Env.ensureEnvSetup()).toThrow(/DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET/)
	})

	// DISCORD_ENABLED=false is an install saying the credentials are already inert, which is what a demo wants
	it('accepts credentials the install has already turned off', async () => {
		const Env = await loadEnv('DISCORD_CLIENT_SECRET=inert\n', { DEMO: '1', DISCORD_ENABLED: 'false', DISCORD_CLIENT_ID: 'inert' })
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})

	// there is no oauth app behind the flow this would register, so nobody could log in
	it('refuses to boot with the no-auth login portal turned off', async () => {
		const Env = await loadEnv('', { DEMO: '1', QUERY_PARAM_AUTH_BYPASS: 'false' })
		expect(() => Env.ensureEnvSetup()).toThrow(/QUERY_PARAM_AUTH_BYPASS/)
	})

	it('refuses to boot with a battlemetrics token, which belongs to a real org', async () => {
		const Env = await loadEnv('BM_PAT=real-token\n', { DEMO: '1' })
		expect(() => Env.ensureEnvSetup()).toThrow(/BM_PAT/)
	})

	it('accepts a battlemetrics token there is only a stub to spend on', async () => {
		const Env = await loadEnv('BM_PAT=stub-token\n', { DEMO: '1', BM_HOST: 'http://127.0.0.1:3123' })
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})

	it('reports every contradiction at once', async () => {
		const Env = await loadEnv('', { DEMO: '1', DISCORD_ENABLED: 'true', QUERY_PARAM_AUTH_BYPASS: 'false' })
		expect(() => Env.ensureEnvSetup()).toThrow(
			/DISCORD_ENABLED[\s\S]*QUERY_PARAM_AUTH_BYPASS|QUERY_PARAM_AUTH_BYPASS[\s\S]*DISCORD_ENABLED/,
		)
	})

	// the shape a dev instance and the test harness both run: inert credentials, and a stub to spend them on
	it('accepts an environment that hands over dummies alongside the stubs they belong to', async () => {
		const Env = await loadEnv('DISCORD_CLIENT_SECRET=disabled\nBM_PAT=stub-token\n', {
			DEMO: '1',
			NODE_ENV: 'development',
			DISCORD_ENABLED: 'false',
			QUERY_PARAM_AUTH_BYPASS: 'true',
			DISCORD_CLIENT_ID: 'disabled',
			DISCORD_BOT_TOKEN: 'disabled',
			DISCORD_HOME_GUILD_ID: '1',
			BM_HOST: 'http://127.0.0.1:3123',
		})
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})

	// none of this is a rule about the variables themselves: without DEMO they are an ordinary deployment
	it('leaves an install that never asked for it alone', async () => {
		const Env = await loadEnv('DISCORD_CLIENT_SECRET=real-secret\nBM_PAT=real-token\n', {
			DISCORD_CLIENT_ID: 'real-id',
			DISCORD_BOT_TOKEN: 'real-token',
			DISCORD_HOME_GUILD_ID: '1',
			SETTINGS_ENCRYPTION_KEY: KEY,
		})
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})

	it('refuses to boot with battlemetrics switched on against the real api', async () => {
		const Env = await loadEnv('', { DEMO: '1', BM_ENABLED: 'true' })
		expect(() => Env.ensureEnvSetup()).toThrow(/BM_ENABLED/)
	})

	it('refuses to boot with a squad browser key, which a demo has no real server to spend on', async () => {
		const Env = await loadEnv('SQUADBROWSER_API_KEY=sqb_real-key\n', { DEMO: '1' })
		expect(() => Env.ensureEnvSetup()).toThrow(/SQUADBROWSER_API_KEY/)
	})

	it('accepts a squad browser key there is only a stub to spend on', async () => {
		const Env = await loadEnv('SQUADBROWSER_API_KEY=sqb_stub-key\n', { DEMO: '1', SQUADBROWSER_HOST: 'http://127.0.0.1:3123' })
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})

	it('refuses to boot with a steam key, which a demo has no real players to spend on', async () => {
		const Env = await loadEnv('STEAM_API_KEY=real-key\n', { DEMO: '1' })
		expect(() => Env.ensureEnvSetup()).toThrow(/STEAM_API_KEY/)
	})

	it('accepts a steam key there is only a stub to spend on', async () => {
		const Env = await loadEnv('STEAM_API_KEY=stub-key\n', { DEMO: '1', STEAM_HOST: 'http://127.0.0.1:3124' })
		expect(() => Env.ensureEnvSetup()).not.toThrow()
	})
})

// same bargain as BM_ENABLED: an install that never configured the squad browser says so by omission, and the
// join button is hidden rather than resolving to a 401 against a third party
describe('SQUADBROWSER_ENABLED', () => {
	it('is off when there is no key and only the real api to spend one on', async () => {
		const Env = await loadEnv('', { DEMO: '1' })
		Env.ensureEnvSetup()
		expect(Env.rawVar('SQUADBROWSER_ENABLED')).toBe('false')
	})

	it('is on for an install that configured a key', async () => {
		const Env = await loadEnv('SQUADBROWSER_API_KEY=sqb_real-key\n', { SETTINGS_ENCRYPTION_KEY: KEY })
		Env.ensureEnvSetup()
		expect(Env.rawVar('SQUADBROWSER_ENABLED')).toBe('true')
	})

	it('leaves an explicit answer alone', async () => {
		const Env = await loadEnv('SQUADBROWSER_API_KEY=sqb_real-key\n', { SETTINGS_ENCRYPTION_KEY: KEY, SQUADBROWSER_ENABLED: 'false' })
		Env.ensureEnvSetup()
		expect(Env.rawVar('SQUADBROWSER_ENABLED')).toBe('false')
	})
})

// the same, for the steam lobby the join button falls back to when the squad browser cannot resolve the server
describe('STEAM_ENABLED', () => {
	it('is off when there is no key and only the real api to spend one on', async () => {
		const Env = await loadEnv('', { DEMO: '1' })
		Env.ensureEnvSetup()
		expect(Env.rawVar('STEAM_ENABLED')).toBe('false')
	})

	it('is on for an install that configured a key', async () => {
		const Env = await loadEnv('STEAM_API_KEY=real-key\n', { SETTINGS_ENCRYPTION_KEY: KEY })
		Env.ensureEnvSetup()
		expect(Env.rawVar('STEAM_ENABLED')).toBe('true')
	})

	it('leaves an explicit answer alone', async () => {
		const Env = await loadEnv('STEAM_API_KEY=real-key\n', { SETTINGS_ENCRYPTION_KEY: KEY, STEAM_ENABLED: 'false' })
		Env.ensureEnvSetup()
		expect(Env.rawVar('STEAM_ENABLED')).toBe('false')
	})
})

// there is no BM_ENABLED an install would already be setting, so an install that never configured battlemetrics
// says so by omission -- and reaching for the api anyway is a 401 per player, against a third party, forever
describe('BM_ENABLED', () => {
	it('is off when there is no token and only the real api to spend one on', async () => {
		const Env = await loadEnv('', { DEMO: '1' })
		Env.ensureEnvSetup()
		expect(Env.rawVar('BM_ENABLED')).toBe('false')
	})

	it('is on for an install that configured a token', async () => {
		const Env = await loadEnv('BM_PAT=real-token\n', { SETTINGS_ENCRYPTION_KEY: KEY })
		Env.ensureEnvSetup()
		expect(Env.rawVar('BM_ENABLED')).toBe('true')
	})

	// a dev instance and the test harness both run a stub with no token, which is a battlemetrics to talk to
	it('is on for a stub, token or no token', async () => {
		const Env = await loadEnv('', { DEMO: '1', BM_HOST: 'http://127.0.0.1:3123' })
		Env.ensureEnvSetup()
		expect(Env.rawVar('BM_ENABLED')).toBe('true')
	})

	it('leaves an explicit answer alone', async () => {
		const Env = await loadEnv('BM_PAT=real-token\n', { SETTINGS_ENCRYPTION_KEY: KEY, BM_ENABLED: 'false' })
		Env.ensureEnvSetup()
		expect(Env.rawVar('BM_ENABLED')).toBe('false')
	})
})
