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
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import * as semver from 'semver'
const gunzip = promisify(zlib.gunzip)
const gzip = promisify(zlib.gzip)
import { z } from 'zod'
import { baseLogger } from '../logger'

export let db!: LayerDb

export const DEFAULT_EXTRA_COLUMNS_CONFIG_PATH = './layer-db.json'

export let LAYER_DB_CONFIG!: LC.LayerDbConfig
const envBuilder = Env.getEnvBuilder({ ...Env.groups.layerDb, ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>

export let hash!: string
export let layersVersion!: string
export let driver!: Database
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

export async function setup(ctx: CS.Log, _opts?: { skipHash?: boolean; mode?: 'populate' | 'read'; logging?: boolean; dbPath?: string }) {
	const opts = _opts ?? {}
	opts.mode ??= 'read'
	mode = opts.mode
	opts.logging ??= true
	ENV = envBuilder()
	setupExtraColsConfig()
	;[dbPath, layersVersion] = opts.dbPath ? [opts.dbPath, 'unknown'] : getVersionTemplatedPath(ENV.LAYERS_DB_PATH)
	let fileBuffer = await fs.promises.readFile(dbPath)

	let dbBuffer: Buffer
	// Decompress if the file is gzipped
	if (dbPath.endsWith('.gz')) {
		dbBuffer = await gunzip(fileBuffer)
	} else {
		dbBuffer = fileBuffer
	}

	driver = new DatabaseConstructor(dbBuffer, { readonly: opts.mode === 'read' })
	driver.pragma('optimize')
	if (opts.mode === 'populate') {
		// this doesn't actually help much currently because we're doing the preprocessing syncronously
		driver.pragma('journal_mode = WAL')
	}

	// IMPORTANT: While the pattern for running queries with this object appears async, it's actually synchronous/blocking. If this becomes an issue on the server we'll need to address it, but for now we're only running queries to autogenerate layers when the queue is empty.
	db = drizzle(driver, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				if (opts.logging) baseLogger.debug({ params }, 'LDB: %s', query)
			},
		},
	})
	if (!opts?.skipHash) {
		hash = crypto.createHash('sha256').update(fileBuffer).digest('hex')
		ctx.log.info('hash for %s: %s', dbPath, hash)
	}
	ctx.log.info('Loaded layer database from %s', dbPath)
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

export async function writePopulated(ctx: CS.Log, dbPath: string) {
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
