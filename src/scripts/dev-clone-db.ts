import * as Schema from '$root/drizzle/schema.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { tsMigrations } from '@/migrations/registry'
import * as SETTINGS from '@/models/settings.models'
import * as Env from '@/server/env'
import * as Migrate from '@/server/migrate'
import * as SecretBox from '@/server/secret-box.server'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import * as E from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import * as DevInstance from '../dev/instance.ts'
import * as Slots from '../dev/slots.ts'

// Clones the main checkout's database into this worktree and re-points its servers at the worktree's
// emulator, so an experiment runs against realistic data instead of an empty db.
//
// The source may be in use by a running app, and must survive this untouched. That is what decides the
// mechanism: `VACUUM INTO` over a read-only connection takes a read transaction and writes a new file. It
// never writes the source, never takes its write lock, and never checkpoints its WAL -- it only reads
// through it, so the clone includes everything committed as of the snapshot. A file copy would be wrong on
// both counts: it would miss the -wal (the clone would silently lose recent writes) and tear across
// concurrent writes.
//
// The destination is the dangerous half, and not for a reason WAL covers. WAL coordinates concurrent
// *connections* to a database; this replaces the *file* behind SQLite's back. An app holding the old file
// open is left writing to an unlinked inode: the writes succeed, and are lost, and it serves reads from a
// database that no longer exists on disk -- silently, with nothing raising an error. Hence lockDest: the
// exclusive lock is held from before the snapshot until after the rename, so an app that boots into that
// window fails loudly on SQLITE_BUSY instead of becoming a ghost.

const args = parseArgs({
	options: {
		from: { type: 'string' },
		force: { type: 'boolean', default: false },
	},
	allowPositionals: false,
})

Env.ensureEnvSetup()

const slot = Slots.requireSlot()
const source = path.resolve(args.values.from ?? path.join(Slots.repoRootCheckout(), 'data/db.sqlite3'))
const dest = path.resolve(process.env.DB_PATH ?? './data/db.sqlite3')

if (!fs.existsSync(source)) {
	console.error(`no database to clone at ${source}`)
	process.exit(1)
}
if (path.resolve(source) === dest) {
	console.error(`source and destination are the same file (${dest}); run this from a worktree, not the main checkout`)
	process.exit(1)
}
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
			console.error(`${dest} is open in another process -- stop this worktree's app before replacing its database.`)
			process.exit(1)
		}
		throw err
	}
}

function snapshot() {
	// readonly is load-bearing rather than good manners: it makes it impossible for this connection to take a
	// write lock on the source, whatever it does next.
	const src = new DatabaseConstructor(source, { readonly: true })
	const tmp = `${dest}.clone-${process.pid}.tmp`
	fs.rmSync(tmp, { force: true })
	try {
		src.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`)
	} finally {
		src.close()
	}
	// The -wal has to go with the file it belongs to, and before the new one takes the name. Left in place it
	// is replayed over the clone as though it described it: the reader then silently sees the *old* database's
	// contents, and integrity_check calls that ok, so nothing anywhere reports a problem.
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dest + suffix, { force: true })
	fs.renameSync(tmp, dest)
}

// The worktree's branch may add migrations the main checkout has never run.
async function migrate(driver: Database) {
	const { applied } = await Migrate.runMigrations(driver, {
		sqlDir: path.resolve(process.cwd(), 'drizzle-sqlite'),
		tsMigrations,
		log: (msg) => console.log(`  ${msg}`),
	})
	if (applied.length > 0) console.log(`applied ${applied.length} migration(s) the source had not run`)
}

// The connection every server that is not the emulator gets. The point is that no connection reaching a real
// squad server survives the clone: the source's rows hold the live RCON host and password, and a disabled row
// keeps them, one settings-page toggle away from a dev instance driving the production server. Port 1 has
// nothing behind it, so re-enabling one of these fails loudly and locally instead.
function deadConnection(serverId: string): SETTINGS.ServerConnection {
	return {
		type: 'local',
		logFile: path.join(DevInstance.DEV_DIR, `disabled-${serverId}.log`),
		rcon: { host: '127.0.0.1', port: 1, password: SecretBox.seal('disabled') },
	}
}

// Re-point the cloned servers at this worktree's emulator. The rows are rewritten in place rather than
// replaced: match history, app events and the layer queue all hang off a server id, and that history is the
// realistic data the clone exists to provide.
async function repointServers(driver: Database) {
	const db = drizzle(driver)
	const rows = await db.select().from(Schema.servers)
	if (rows.length === 0) {
		console.error('the cloned database has no servers to re-point')
		process.exit(1)
	}

	// Only one emulator runs per worktree, so only one server can be live. Prefer the one that was already
	// the default so the app comes up on the server the data is mostly about.
	const target = rows.find((row) => row.defaultServer) ?? rows[0]

	for (const row of rows) {
		const parsed = SETTINGS.ServerSettingsSchema.safeParse(unsuperjsonify(Schema.servers, row).settings)
		if (!parsed.success) {
			// Its connections cannot be read, so they cannot be scrubbed either. Disabling is all that is left,
			// and the app's own repair flow is what fixes such a row.
			console.error(`server ${row.id} has settings that do not parse; disabling it without scrubbing its connection`)
			await db.update(Schema.servers).set({ enabled: false, defaultServer: false }).where(E.eq(Schema.servers.id, row.id))
			continue
		}

		const isTarget = row.id === target.id
		const settings: SETTINGS.ServerSettings = {
			...parsed.data,
			connections: isTarget
				? {
					type: 'local',
					logFile: DevInstance.SQUAD_LOG_PATH,
					rcon: {
						host: '127.0.0.1',
						port: slot.ports.rcon,
						// sealed here rather than written plaintext: this column is encrypted at rest, and a row that
						// disagrees with that would be re-sealed on boot anyway.
						password: SecretBox.seal(DevInstance.RCON_PASSWORD),
					},
				}
				: deadConnection(row.id),
			adminListSources: isTarget ? [{ type: 'local', source: DevInstance.ADMINS_CFG_PATH }] : [],
		}
		await db.update(Schema.servers)
			.set(superjsonify(Schema.servers, { settings, enabled: isTarget, defaultServer: isTarget }))
			.where(E.eq(Schema.servers.id, row.id))
		console.log(
			isTarget
				? `re-pointed server ${row.id} at the emulator (rcon 127.0.0.1:${slot.ports.rcon})`
				: `disabled server ${row.id} and scrubbed its connection`,
		)
	}
}

console.log(`cloning ${source}\n     -> ${dest}`)
// held across the snapshot and the rename, not just checked before them
const destLock = lockDest()
try {
	snapshot()
} finally {
	destLock?.close()
}

const driver = new DatabaseConstructor(dest)
driver.pragma('journal_mode = WAL')
try {
	const integrity = driver.pragma('integrity_check', { simple: true })
	if (integrity !== 'ok') throw new Error(`the clone failed its integrity check: ${String(integrity)}`)
	await migrate(driver)
	await repointServers(driver)
} finally {
	driver.close()
}

console.log(`done -- slot ${slot.slot}, app on :${slot.ports.app}, client on :${slot.ports.client}`)
