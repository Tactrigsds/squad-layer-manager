import * as Paths from '$root/paths'
import { escapeRegex } from '@/lib/string'
import type * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import type { LayerDb } from '@/models/layer-db'
import * as Env from '@/server/env'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import crypto from 'crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Mustache from 'mustache'
import fs from 'node:fs'
import os from 'node:os'
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
// path to the decompressed temp copy opened in read mode for a gzipped source; removed on shutdown
let tempDbPath: string | null = null

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
	ready = load(opts)
	return ready
}

async function load(opts: { skipHash?: boolean; mode?: 'populate' | 'read'; logging?: boolean }) {
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
		// gzipped dbs can't be opened directly by sqlite, so stream-decompress to a temp
		// file first (streaming keeps the decompressed bytes off the JS heap).
		let openPath = dbPath
		if (dbPath.endsWith('.gz')) {
			openPath = await decompressToTemp(dbPath)
			tempDbPath = openPath
		}
		driver = new DatabaseConstructor(openPath, { readonly: true })
		driver.pragma('mmap_size = 268435456') // 256MiB of memory-mapped reads
		CleanupSys.register(() => {
			driver?.close()
			if (tempDbPath) {
				try {
					fs.unlinkSync(tempDbPath)
				} catch (err) {
					log.warn(err, 'failed to remove temp layer db %s', tempDbPath)
				}
				tempDbPath = null
			}
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
		// hash the on-disk bytes (compressed, if gzipped) so the served ETag is unchanged
		hash = await hashFile(dbPath)
		log.info('hash for %s: %s', dbPath, hash)
	}
	log.info('Loaded layer database from %s', dbPath)
}

// stream-decompress a gzipped db to a temp file so sqlite can open it disk-backed
async function decompressToTemp(gzPath: string): Promise<string> {
	const tmpPath = path.join(os.tmpdir(), `layer-db-${crypto.randomUUID()}.sqlite3`)
	await pipeline(fs.createReadStream(gzPath), zlib.createGunzip(), fs.createWriteStream(tmpPath))
	return tmpPath
}

// hash a file's contents without holding it in memory
async function hashFile(filePath: string): Promise<string> {
	const hasher = crypto.createHash('sha256')
	await pipeline(fs.createReadStream(filePath), hasher)
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
