import * as LC from '@/models/layer-columns'
import { LayerDb } from '@/models/layer-db'
import * as Env from '@/server/env'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import fs from 'node:fs'
import { baseLogger } from '../logger'

export let db!: LayerDb

export const DEFAULT_EXTRA_COLUMNS_CONFIG_PATH = './layer-db.json'

export let LAYER_DB_CONFIG!: LC.LayerDbConfig
const envBuilder = Env.getEnvBuilder({ ...Env.groups.layerDb })
let ENV!: ReturnType<typeof envBuilder>

export let hash!: string

export function setupExtraColsConfig() {
	if (!ENV) ENV = envBuilder()
	let canAccess: boolean
	try {
		fs.accessSync(ENV.LAYER_DB_CONFIG_PATH)
		canAccess = true
	} catch {
		canAccess = false
	}
	if (!canAccess && ENV.LAYER_DB_CONFIG_PATH === DEFAULT_EXTRA_COLUMNS_CONFIG_PATH) {
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

export async function setup(opts?: { skipHash?: boolean; mode?: 'populate' | 'read'; logging?: boolean }) {
	opts ??= {}
	opts.mode ??= 'read'
	opts.logging ??= true
	ENV = envBuilder()
	setupExtraColsConfig()

	let driver = Database(ENV.LAYERS_DB_PATH, {
		readonly: opts.mode === 'read',
		fileMustExist: opts.mode === 'read',
		verbose: console.log,
	})
	let buf: Buffer | undefined
	if (opts.mode === 'read') {
		buf = driver.serialize()
		// @ts-expect-error types are wrong https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#serializeoptions---buffer
		driver = Database(buf, { readonly: true })
	} else if (opts.mode === 'populate') {
		driver.pragma('journal_mode = WAL')
	}
	db = drizzle(ENV.LAYERS_DB_PATH, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				if (opts.logging) baseLogger.debug({ params }, 'LDB: %s', query)
			},
		},
	})

	if (!opts?.skipHash) {
		const fileBuffer = buf ?? driver.serialize()
		hash = crypto.createHash('sha256').update(fileBuffer).digest('hex')
	}
}

export function readFilestream() {
	if (!fs.existsSync(ENV.LAYERS_DB_PATH)) {
		throw new Error('File does not exist: ' + ENV.LAYERS_DB_PATH)
	}

	return fs.createReadStream(ENV.LAYERS_DB_PATH)
}
