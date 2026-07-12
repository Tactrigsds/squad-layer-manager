import * as Paths from '$root/paths'
import { escapeRegex } from '@/lib/string'
import type * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import type { LayerDb } from '@/models/layer-db'
import * as Env from '@/server/env'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import crypto from 'crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableConfig, getViewConfig, SQLiteSyncDialect, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import Mustache from 'mustache'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import * as semver from 'semver'
const gunzip = promisify(zlib.gunzip)
const gzip = promisify(zlib.gzip)
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'

import { z } from 'zod'

const module = initModule('layer-db')
let log!: CS.Logger
export let db!: LayerDb

export const DEFAULT_EXTRA_COLUMNS_CONFIG_PATH = './layer-db.json'

export let LAYER_DB_CONFIG!: LC.LayerDbConfig
const envBuilder = Env.getEnvBuilder({ ...Env.groups.layerDb, ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>

export let hash!: string
export let layersVersion!: string
export let driver!: Database
// resolves once the layer db has been opened (and hashed). `db`, `hash` and `driver` are only
// populated once this settles, so callers must await it before touching the layer db.
export let ready!: Promise<void>
let dbPath!: string

let mode!: 'populate' | 'read'

export function setupExtraColsConfig() {
	if (!ENV) ENV = envBuilder()
	if (ENV.NODE_ENV === 'development') {
		generateJsonSchema()
	}
	let canAccess: boolean
	try {
		fs.accessSync(ENV.LAYER_DB_CONFIG_PATH)
		canAccess = true
	} catch {
		canAccess = false
	}
	if (!canAccess && ENV.LAYER_DB_CONFIG_PATH !== DEFAULT_EXTRA_COLUMNS_CONFIG_PATH) {
		throw new Error(`Cannot access ${ENV.LAYER_DB_CONFIG_PATH}`)
	} else if (!canAccess) {
		LAYER_DB_CONFIG = {
			columns: [],
			generation: {
				columnOrder: [],
				weights: {},
			},
		}
	} else {
		const raw = fs.readFileSync(ENV.LAYER_DB_CONFIG_PATH, 'utf-8')
		LAYER_DB_CONFIG = LC.LayerDbConfigSchema.parse(JSON.parse(raw))
	}
}

// Resolves the config synchronously (so `LAYER_DB_CONFIG`/`layersVersion` are available immediately)
// and kicks off opening the db in the background. The returned promise (also exposed as `ready`)
// settles once `db`/`hash`/`driver` are populated, so it does not block the startup procedure —
// callers await `ready` right before they need the layer db.
export function setup(_opts?: { skipHash?: boolean; mode?: 'populate' | 'read'; logging?: boolean; dbPath?: string }): Promise<void> {
	log = module.getLogger()
	const opts = _opts ?? {}
	opts.mode ??= 'read'
	mode = opts.mode
	opts.logging ??= true
	ENV = envBuilder()
	setupExtraColsConfig()
	;[dbPath, layersVersion] = opts.dbPath ? [opts.dbPath, 'unknown'] : getVersionTemplatedPath(ENV.LAYERS_DB_PATH)
	// abort the setup I/O (decompression, hashing) if the process starts shutting down mid-startup
	const ctx: CS.AbortSignal = { signal: CleanupSys.shutdownSignal }
	ready = load(ctx, opts)
	return ready
}

async function load(ctx: CS.AbortSignal, opts: { skipHash?: boolean; mode?: 'populate' | 'read'; logging?: boolean }) {
	if (opts.mode === 'populate') {
		// populate mutates the db and then backs it up, so it needs a writable, in-memory
		// deserialized database. Memory isn't a concern for the one-off preprocess script.
		const fileBuffer = await fs.promises.readFile(dbPath)
		const dbBuffer = dbPath.endsWith('.gz') ? await gunzip(fileBuffer) : fileBuffer
		driver = new DatabaseConstructor(dbBuffer, { readonly: false })
		driver.pragma('optimize')
		// this doesn't actually help much currently because we're doing the preprocessing syncronously
		driver.pragma('journal_mode = WAL')
	} else {
		// read mode: open the file disk-backed so RSS doesn't scale with the db size.
		let openPath = dbPath
		if (dbPath.endsWith('.gz')) {
			// gzipped dbs can't be opened directly by sqlite, so we stream-decompress to a copy
			// (streaming keeps the decompressed bytes off the JS heap). The copy is content-addressed
			// by the source hash so identical sources reuse the same file across restarts (skipping
			// re-decompression) and stale copies are swept on startup. This bounds ./data/decompressed
			// to a single file no matter how prior processes exited: SIGTERM cleanup alone leaks the
			// copy on crash/OOM/SIGKILL. Assumes a single server process per data dir.
			hash = await hashFile(ctx, dbPath)
			openPath = await ensureDecompressed(ctx, dbPath, hash)
		}
		driver = new DatabaseConstructor(openPath, { readonly: true })
		driver.pragma('mmap_size = 268435456') // 256MiB of memory-mapped reads
		// leave the decompressed copy in place on shutdown so the next boot of the same version can
		// reuse it; startup sweep in ensureDecompressed reclaims it once the version changes.
		CleanupSys.register(() => {
			driver?.close()
		})
	}

	// IMPORTANT: While the pattern for running queries with this object appears async, it's actually synchronous/blocking. If this becomes an issue on the server we'll need to address it, but for now we're only running queries to autogenerate layers when the queue is empty.
	db = drizzle(driver, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				if (opts.logging) log.debug({ params }, 'LDB: %s', query)
			},
		},
	})
	if (!opts?.skipHash) {
		// hash the on-disk bytes (compressed, if gzipped) so the served ETag is unchanged.
		// the gz read path already hashed the source above to name its decompressed copy.
		hash ??= await hashFile(ctx, dbPath)
		log.info('hash for %s: %s', dbPath, hash)
	}
	log.info('Loaded layer database from %s', dbPath)
}

// stream-decompress a gzipped db to a stable, content-addressed copy so sqlite can open it
// disk-backed. Written under ./data/decompressed (on the regular disk) rather than os.tmpdir(),
// which on some hosts is a size- or quota-limited tmpfs that can't hold the decompressed db.
// Reuses an existing copy for the same source hash, and sweeps every other layer-db-* file (stale
// versions, or copies/partials orphaned by a crash) so the directory holds at most one copy.
async function ensureDecompressed(ctx: CS.AbortSignal, gzPath: string, sourceHash: string): Promise<string> {
	const dir = path.join(Paths.DATA, 'decompressed')
	await fs.promises.mkdir(dir, { recursive: true })
	await writeDecompressedInfoFile(ctx, dir)
	const targetName = `layer-db-${sourceHash}.sqlite3`
	const targetPath = path.join(dir, targetName)

	// sweep every prior copy/partial except the one we're about to (re)use
	for (const entry of await fs.promises.readdir(dir)) {
		if (entry === targetName || !/^layer-db-.*\.(sqlite3|tmp)$/.test(entry)) continue
		try {
			await fs.promises.unlink(path.join(dir, entry))
		} catch (err) {
			log.warn(err, 'failed to remove stale decompressed layer db %s', entry)
		}
	}

	// reuse an already-decompressed copy for this source
	try {
		if ((await fs.promises.stat(targetPath)).size > 0) {
			log.info('reusing decompressed layer db %s', targetPath)
			return targetPath
		}
	} catch {
		// not present; fall through to decompress
	}

	// decompress to a uuid-suffixed temp then atomically rename, so a crash mid-decompress never
	// leaves a truncated file that a later boot would mistake for a complete copy
	const tmpPath = path.join(dir, `layer-db-${sourceHash}.${crypto.randomUUID()}.tmp`)
	await pipeline(fs.createReadStream(gzPath), zlib.createGunzip(), fs.createWriteStream(tmpPath), { signal: ctx.signal })
	await fs.promises.rename(tmpPath, targetPath)
	log.info('decompressed layer db to %s', targetPath)
	return targetPath
}

const DECOMPRESSED_INFO_FILENAME = 'INFO.txt'
const DECOMPRESSED_INFO_TEXT = `This directory is managed automatically by the server (src/systems/layer-db.server.ts).

The layer database ships gzipped (data/layers_v*.sqlite3.gz). sqlite cannot open a gzipped file, so
on startup the server decompresses the active version to a disk-backed copy here and opens it read-only
(disk-backed so process memory does not scale with the database size).

Each copy is named layer-db-<sha256-of-source>.sqlite3 and is content-addressed by the source hash,
so the same source is reused across restarts. On every startup the server sweeps every other
layer-db-* file in this directory, so it holds at most one copy for the current version.

These files are regenerated on demand. It is safe to delete anything in this directory while the
server is stopped. Do not edit the copies by hand; they are treated as disposable.
`

// keep an INFO.txt in the decompressed dir explaining what the machine-generated files are.
// rewritten only when its contents drift, so we don't churn its mtime on every boot.
async function writeDecompressedInfoFile(ctx: CS.AbortSignal, dir: string): Promise<void> {
	const infoPath = path.join(dir, DECOMPRESSED_INFO_FILENAME)
	try {
		if (await fs.promises.readFile(infoPath, { encoding: 'utf-8', signal: ctx.signal }) === DECOMPRESSED_INFO_TEXT) return
	} catch {
		// missing or unreadable; (re)write below
	}
	try {
		await fs.promises.writeFile(infoPath, DECOMPRESSED_INFO_TEXT, { signal: ctx.signal })
	} catch (err) {
		log.warn(err, 'failed to write %s in decompressed layer db dir', DECOMPRESSED_INFO_FILENAME)
	}
}

// hash a file's contents without holding it in memory
async function hashFile(ctx: CS.AbortSignal, filePath: string): Promise<string> {
	const hasher = crypto.createHash('sha256')
	await pipeline(fs.createReadStream(filePath), hasher, { signal: ctx.signal })
	return hasher.digest('hex')
}

export function readFilestream() {
	if (!fs.existsSync(dbPath)) {
		throw new Error('File does not exist: ' + dbPath)
	}

	const contentType = dbPath.endsWith('.gz') ? 'application/gzip' : 'application/x-sqlite3'
	return [fs.createReadStream(dbPath), contentType]
}

export function getVersionTemplatedPath(filePath: string): [string, string] {
	if (!filePath.includes('{{LAYERS_VERSION}}')) {
		return [filePath, 'unknown']
	}

	if (ENV.LAYERS_VERSION === '@latest') {
		// in this case we look for  where {{LAYERS_VERSION}} is in the path and replace it with the path segment that uses the same pattern as the input path and has the highest version
		const segments = filePath.split('/')
		const segmentIndex = segments.findIndex((segment) => segment.includes('{{LAYERS_VERSION}}'))
		if (segmentIndex === -1) return [filePath, 'unknown']
		const [before, after] = segments[segmentIndex].split('{{LAYERS_VERSION}}')
		const dir = segments.slice(0, segmentIndex).join('/')

		const regex = new RegExp(`^${escapeRegex(before)}([^/]+)${escapeRegex(after)}$`)

		const matches: Array<{ segment: string; version: string }> = []
		for (const segment of fs.readdirSync(dir)) {
			const match = segment.match(regex)
			if (match && match[1]) {
				const validVersion = semver.valid(match[1])
				if (validVersion) {
					matches.push({ segment, version: validVersion })
				}
			}
		}

		if (matches.length === 0) {
			const expectedPattern = Mustache.render(filePath, { LAYER_DB_VERSION: '<version>' })
			throw new Error(
				`No files found matching ${expectedPattern} where <version> is a valid semver (e.g., 1.2.3, v2.0.0-beta.1)`,
			)
		}

		// Sort by semver
		const versions = matches.sort((a, b) => semver.compare(a.version, b.version))
		const latestVersion = versions[versions.length - 1]
		const modifiedSegment = Mustache.render(latestVersion.segment, { LAYERS_VERSION: ENV.LAYERS_VERSION })
		const modifiedSegments = [...segments]
		modifiedSegments[segmentIndex] = modifiedSegment
		return [modifiedSegments.join('/'), latestVersion.version]
	}

	return [Mustache.render(filePath, { LAYERS_VERSION: ENV.LAYERS_VERSION }), ENV.LAYERS_VERSION]
}

const ddlDialect = new SQLiteSyncDialect()

function tableDDL(table: SQLiteTable): string[] {
	const cfg = getTableConfig(table)
	const cols = cfg.columns.map((c) => {
		let line = `\`${c.name}\` ${c.getSQLType()}`
		if (c.primary) line += ' PRIMARY KEY'
		if (c.notNull) line += ' NOT NULL'
		return line
	})
	const stmts = [`CREATE TABLE \`${cfg.name}\` (\n\t${cols.join(',\n\t')}\n)`]
	for (const idx of cfg.indexes) {
		const { name, columns, unique } = idx.config
		const colList = columns.map((col) => `\`${(col as { name: string }).name}\``).join(', ')
		stmts.push(`CREATE ${unique ? 'UNIQUE INDEX' : 'INDEX'} \`${name}\` ON \`${cfg.name}\` (${colList})`)
	}
	return stmts
}

// DDL for a fresh layer db: the layers + extra-cols tables (with their single-column indexes) and
// the joined view. Generated from the drizzle schema so it tracks the config-driven extra columns.
// Replaces spawning `drizzle-kit push`, which needs the src tree + config that the slim prod image
// doesn't ship; keeping this in-process lets the bundled preprocess script be self-contained.
export function getSchemaStatements(ctx: CS.EffectiveColumnConfig): string[] {
	const viewCfg = getViewConfig(LC.layersView(ctx))
	const viewSql = ddlDialect.sqlToQuery(viewCfg.query!).sql
	return [
		...tableDDL(LC.layers),
		...tableDDL(LC.extraColsSchema(ctx)),
		`CREATE VIEW \`${viewCfg.name}\` AS ${viewSql}`,
	]
}

// Creates a fresh db file at `dbPath` containing only the layer db schema. Left in the default
// (rollback-journal) mode so the schema lands in the main file, which `setup({ mode: 'populate' })`
// then reads back in full.
export function createSchemaFile(ctx: CS.EffectiveColumnConfig, dbPath: string) {
	const schemaDriver = new DatabaseConstructor(dbPath)
	try {
		for (const stmt of getSchemaStatements(ctx)) schemaDriver.exec(stmt)
	} finally {
		schemaDriver.close()
	}
}

export async function writePopulated(dbPath: string) {
	if (mode !== 'populate') throw new Error('Cannot write to file in read mode')

	// If output path is gzipped, backup to temp file first, then compress
	if (dbPath.endsWith('.gz')) {
		const tempPath = dbPath.replace(/\.gz$/, '.tmp')
		await driver.backup(tempPath)
		const buffer = await fs.promises.readFile(tempPath)
		const compressed = await gzip(buffer)
		await fs.promises.writeFile(dbPath, compressed)
		await fs.promises.unlink(tempPath)
	} else {
		await driver.backup(dbPath)
	}
}

function generateJsonSchema() {
	const schemaPath = path.join(Paths.ASSETS, 'db-config-schema.json')
	const schema = z.toJSONSchema(LC.LayerDbConfigSchema, { io: 'input' })
	fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2))
}
