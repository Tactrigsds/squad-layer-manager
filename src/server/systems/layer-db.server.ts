import * as LC from '@/models/layer-columns'
import { LayerDb } from '@/models/layer-db'
import * as Env from '@/server/env'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import fsPromise from 'fs/promises'
import fs from 'node:fs'
import { baseLogger } from './logger.client'

export let db!: LayerDb

export const LAYERS_DB_PATH = 'data/layers.sqlite3'
export const DEFAULT_EXTRA_COLUMNS_CONFIG_PATH = './extra-columns.json'

export let EXTRA_COLS_CONFIG!: LC.ExtraColumnsConfig
const envBuilder = Env.getEnvBuilder({ ...Env.groups.layersDb })
let ENV!: ReturnType<typeof envBuilder>

export let hash!: string

export function setupExtraColsConfig() {
	ENV = envBuilder()
	let canAccess: boolean
	try {
		fs.accessSync(ENV.EXTRA_COLUMNS_CONFIG_PATH)
		canAccess = true
	} catch {
		canAccess = false
	}
	if (!canAccess && ENV.EXTRA_COLUMNS_CONFIG_PATH === DEFAULT_EXTRA_COLUMNS_CONFIG_PATH) {
		throw new Error(`Cannot access ${ENV.EXTRA_COLUMNS_CONFIG_PATH}`)
	} else if (!canAccess) {
		EXTRA_COLS_CONFIG = {
			columns: [],
		}
	} else {
		const raw = fs.readFileSync(ENV.EXTRA_COLUMNS_CONFIG_PATH, 'utf-8')
		EXTRA_COLS_CONFIG = LC.ExtraColumnsConfigSchema.parse(JSON.parse(raw))
	}
}

export async function setup(opts?: { skipHash?: boolean; mode?: 'populate' | 'query' }) {
	opts ??= {}
	opts.mode ??= 'query'

	setupExtraColsConfig()

	const driver = Database(LAYERS_DB_PATH, {
		readonly: opts.mode === 'query',
		fileMustExist: opts.mode === 'query',
		verbose: console.log,
	})
	if (opts.mode === 'populate') {
		driver.pragma('journal_mode = WAL')
	}
	db = drizzle(LAYERS_DB_PATH)

	if (!opts?.skipHash) {
		const fileBuffer = await fsPromise.readFile(LAYERS_DB_PATH)
		hash = crypto.createHash('sha256').update(fileBuffer).digest('hex')
	}
}

export function readFilestream() {
	if (!fs.existsSync(LAYERS_DB_PATH)) {
		throw new Error('File does not exist: ' + LAYERS_DB_PATH)
	}

	return fs.createReadStream(LAYERS_DB_PATH)
}
