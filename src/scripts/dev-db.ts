import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as Schema from '$root/drizzle/schema.ts'
import { superjsonify } from '@/lib/drizzle'
import { tsMigrations } from '@/migrations/registry'
import * as CS from '@/models/context-shared.models'
import * as SETTINGS from '@/models/settings.models'
import * as Env from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'
import * as Migrate from '@/server/migrate'
import * as SecretBox from '@/server/secret-box.server'
import * as Seed from '@/systems/seed.server'

import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'
import * as BmServer from '../emulator/bm-server.ts'

// the single admin list a dev workspace keeps, pointed at the worktree's emulated Admins.cfg
const DEV_ADMIN_LIST = 'dev'

// the one server a workspace has: this worktree's emulator
const DEV_SERVER_ID = 'emulator'

// Gives this worktree a fresh database for its instance, migrated by the worktree's own build and seeded the way the
// app's own first boot would seed it, with its one server pointed at the worktree's emulator. Never a copy of another
// checkout's database: that one may have been migrated by a newer build than this worktree's, which the app refuses
// to run on.
//
// Replacing an existing database is the dangerous part. An app holding the old file open is left writing to an
// unlinked inode: the writes succeed, and are lost, and it serves reads from a database that no longer exists on
// disk, with nothing raising an error. Hence lockDest: the exclusive lock is held while the old file is removed, so
// an app that boots into that window fails loudly on SQLITE_BUSY instead.

const args = parseArgs({
	options: {
		force: { type: 'boolean', default: false },
	},
	allowPositionals: false,
})

Env.ensureEnvSetup()
// Seed.setup logs through a module logger, which nothing has stood up in a script.
ensureLoggerSetup()

const slot = Slots.requireSlot()
const superUsers = Env.getEnvBuilder({ ...Env.groups.rbac })().SUPER_USERS
const dest = path.resolve(process.env.DB_PATH ?? './data/db.sqlite3')

if (fs.existsSync(dest) && !args.values.force) {
	console.error(`${dest} already exists. Pass --force to replace it.`)
	process.exit(1)
}

// Takes an exclusive lock on the destination and keeps it, returning the connection holding it; the caller
// closes that to release. Null when there is no destination yet, which is the nothing-to-protect case.
//
// An exclusive lock, not `BEGIN IMMEDIATE`. A running app that happens not to be writing holds no write lock,
// so BEGIN IMMEDIATE succeeds against it and the check would pass exactly when it matters most. Exclusive
// locking mode conflicts with any other connection, idle or not, and -- unlike an ordinary transaction -- it
// keeps the file locks until the connection closes, so the probe below leaves the lock in place.
function lockDest(): Database | null {
	if (!fs.existsSync(dest)) return null
	const driver = new DatabaseConstructor(dest)
	driver.pragma('busy_timeout = 2000')
	try {
		driver.pragma('locking_mode = EXCLUSIVE')
		driver.exec('BEGIN IMMEDIATE')
		driver.exec('ROLLBACK')
		return driver
	} catch (err) {
		if (driver.inTransaction) driver.exec('ROLLBACK')
		driver.close()
		const code = (err as { code?: string }).code
		if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') {
			console.error(`${dest} is open in another process -- stop this workspace's app before replacing its database.`)
			process.exit(1)
		}
		throw err
	}
}

// The -wal has to go with the file it belongs to, and before a new one takes the name. Left in place it is
// replayed over whatever arrives as though it described it: the reader then silently sees the *old*
// database's contents, and integrity_check calls that ok, so nothing anywhere reports a problem.
function clearDest() {
	fs.mkdirSync(path.dirname(dest), { recursive: true })
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dest + suffix, { force: true })
}

async function migrate(driver: Database) {
	const { applied } = await Migrate.runMigrations(driver, {
		sqlDir: path.resolve(process.cwd(), 'drizzle-sqlite'),
		tsMigrations,
		log: (msg) => console.log(`  ${msg}`),
	})
	if (applied.length > 0) console.log(`applied ${applied.length} migration(s)`)
}

// Where this worktree's emulator answers. The password is sealed rather than written plaintext: the column is
// encrypted at rest, and a row that disagreed with that would be re-sealed on boot anyway.
function emulatorConnection(): SETTINGS.ServerConnection {
	return {
		type: 'local',
		logFile: DevInstance.SQUAD_LOG_PATH,
		rcon: { host: '127.0.0.1', port: slot.ports.rcon, password: SecretBox.seal(DevInstance.RCON_PASSWORD) },
	}
}

// The integrations a workspace runs with: the battlemetrics stub the emulator host serves (see dev/instance.ts),
// which wants the org id it claims, and nothing else. Nothing in a dev instance may reach a real service.
function devIntegrations(): SETTINGS.Integrations {
	return {
		battlemetrics: { enabled: true, token: 'dev', orgId: BmServer.STUB_ORG_ID },
		squadBrowser: { enabled: true, token: '' },
		steam: { enabled: true, token: '' },
	}
}

// What the app's own first boot would write to an empty database, written here instead: a workspace has to be
// pointed at its emulator and signed in to before anyone sees it, and both need rows to exist by then. The one admin
// list it keeps is the emulator's Admins.cfg.
//
// Order matters. Seed.setup only runs against a database that has never been configured, which is what an
// empty globalSettings table means, so the filters the pool config below names are seeded before the global
// settings row that would make the app skip them.
async function seed(driver: Database) {
	const db = drizzle(driver)
	await Seed.setup({ ...CS.init(), db: () => db })

	const defaults = SETTINGS.parseGlobalSettings({})
	if (!defaults.success) throw new Error('default global settings failed schema validation', { cause: defaults.error })
	await db.insert(Schema.globalSettings).values(
		superjsonify(Schema.globalSettings, {
			id: 1,
			settings: SETTINGS.GlobalSettingsSchema.encode({
				...Seed.applyInitialGlobalSettings(defaults.data),
				integrations: devIntegrations(),
				adminLists: {
					[DEV_ADMIN_LIST]: {
						source: { type: 'local', source: DevInstance.ADMINS_CFG_PATH },
						adminIdentifyingPermissions: ['canseeadminchat'],
					},
				},
			}),
		}),
	)

	// The user `instanceUrl` signs in as. It carries a configured super user's id where there is one, since that
	// is the only route to a permission with discord off: RBAC's other roles are discord roles.
	const discordId = superUsers[0] ?? DevInstance.DEV_USER.discordId
	await db.insert(Schema.discordAccounts).values({ discordId, username: DevInstance.DEV_USER.username })
	await db.insert(Schema.users).values({ discordId })
	if (superUsers.length === 0) {
		console.error(`SUPER_USERS is empty, so ${DevInstance.DEV_USER.username} can administer nothing; put ${discordId} in it`)
	}

	const settings = Seed.applyInitialPoolConfig(
		SETTINGS.ServerSettingsSchema.parse({ connections: emulatorConnection(), adminLists: [DEV_ADMIN_LIST] }),
	)
	await db.insert(Schema.servers).values(
		superjsonify(Schema.servers, {
			id: DEV_SERVER_ID,
			displayName: 'Emulated Server',
			enabled: true,
			defaultServer: true,
			settings,
		}),
	)
	await Slots.setLogin(DevInstance.DEV_USER.username)
	console.log(`seeded the '${DEV_SERVER_ID}' server and the '${DevInstance.DEV_USER.username}' user, which this instance signs in as`)
}

console.log(`starting ${dest} empty`)
// held across the removal, not just checked before it
const destLock = lockDest()
try {
	clearDest()
} finally {
	destLock?.close()
}

const driver = new DatabaseConstructor(dest)
driver.pragma('journal_mode = WAL')
try {
	await migrate(driver)
	await seed(driver)
} finally {
	driver.close()
}

console.log(`done -- slot ${slot.slot}`)
