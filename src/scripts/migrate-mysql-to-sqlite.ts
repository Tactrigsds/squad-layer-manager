import * as Schema from '$root/drizzle/schema'
import * as Env from '@/server/env.ts'
import * as Cli from '@/systems/cli.server'
import DatabaseConstructor from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import mysql from 'mysql2/promise'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Migrates application data from a live MySQL database into the SQLite schema.
 *
 * Required env vars for the source database:
 *   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
 *
 * Legacy fallbacks are also supported:
 *   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_DATABASE
 *
 * Usage:
 *   pnpm run script ./src/scripts/migrate-mysql-to-sqlite.ts
 *   pnpm run script ./src/scripts/migrate-mysql-to-sqlite.ts --apply
 *   pnpm run script ./src/scripts/migrate-mysql-to-sqlite.ts --apply --truncate-target
 */

// strip script-specific flags before the app's CLI parser (which rejects unknown options) sees them
const scriptFlags = new Set(['--apply', '--truncate-target'])
const passedFlags = process.argv.filter((arg) => scriptFlags.has(arg))
process.argv = process.argv.filter((arg) => !scriptFlags.has(arg))

await Cli.ensureCliParsed()
Env.ensureEnvSetup()

const envBuilder = Env.getEnvBuilder({ ...Env.groups.db })
const ENV = envBuilder()

const APPLY = passedFlags.includes('--apply')
const TRUNCATE_TARGET = passedFlags.includes('--truncate-target')
const CHUNK_SIZE = 1000

const MYSQL_HOST = process.env.MYSQL_HOST ?? process.env.DB_HOST
const MYSQL_PORT = Number(process.env.MYSQL_PORT ?? process.env.DB_PORT ?? 3306)
const MYSQL_USER = process.env.MYSQL_USER ?? process.env.DB_USER
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD ?? process.env.DB_PASSWORD
const MYSQL_DATABASE = process.env.MYSQL_DATABASE ?? process.env.DB_DATABASE

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE) {
	throw new Error(
		'Missing MySQL connection env vars. Set MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE (or legacy DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE).',
	)
}

function logInfo(message: string, ...args: unknown[]) {
	console.log(message, ...args)
}

function logWarn(message: string, ...args: unknown[]) {
	console.warn(message, ...args)
}

function logError(message: string, ...args: unknown[]) {
	console.error(message, ...args)
}

function toBigInt(value: unknown): bigint | null {
	if (value === null || value === undefined || value === '') return null
	if (typeof value === 'bigint') return value
	if (typeof value === 'number') return BigInt(value)
	if (typeof value === 'string') return BigInt(value)
	throw new Error(`Cannot convert ${JSON.stringify(value)} to bigint`)
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null
	if (typeof value === 'number') return value
	if (typeof value === 'bigint') return Number(value)
	if (typeof value === 'string') return Number(value)
	throw new Error(`Cannot convert ${JSON.stringify(value)} to number`)
}

function toBoolean(value: unknown): boolean | null {
	if (value === null || value === undefined) return null
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') return value !== 0
	if (typeof value === 'bigint') return value !== 0n
	if (typeof value === 'string') {
		if (value === '1' || value.toLowerCase() === 'true') return true
		if (value === '0' || value.toLowerCase() === 'false') return false
	}
	throw new Error(`Cannot convert ${JSON.stringify(value)} to boolean`)
}

function toDate(value: unknown): Date | null {
	if (value === null || value === undefined || value === '') return null
	if (value instanceof Date) return value
	if (typeof value === 'string' || typeof value === 'number') return new Date(value)
	throw new Error(`Cannot convert ${JSON.stringify(value)} to Date`)
}

function parseJsonValue<T = unknown>(value: unknown): T | null {
	if (value === null || value === undefined) return null
	if (typeof value === 'string') return JSON.parse(value) as T
	return value as T
}

function isLikelySteamLikeId(value: unknown): value is string {
	if (typeof value !== 'string') return false
	return /^\d{6,20}$/.test(value)
}

function deepCloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value))
}

type SourceRow = Record<string, any>

type TableMigration = {
	name: string
	targetName: string
	target: any
	orderBy: readonly string[] | null
	// either prepareRows (loads + transforms the whole source table) or transformRow (per-row, batched) must be set
	prepareRows?: () => Promise<any[]>
	transformRow?: (row: SourceRow) => any
	insert?: (rows: any[]) => Promise<void>
}

fs.mkdirSync(path.dirname(ENV.DB_PATH), { recursive: true })
const sqliteDriver = new DatabaseConstructor(ENV.DB_PATH)
sqliteDriver.pragma('journal_mode = WAL')
sqliteDriver.pragma('synchronous = NORMAL')
sqliteDriver.pragma('foreign_keys = ON')
sqliteDriver.pragma('busy_timeout = 5000')
const sqliteDb = drizzle(sqliteDriver)

const mysqlConn = await mysql.createConnection({
	host: MYSQL_HOST,
	port: MYSQL_PORT,
	user: MYSQL_USER,
	password: MYSQL_PASSWORD,
	database: MYSQL_DATABASE,
	supportBigNumbers: true,
	bigNumberStrings: true,
	dateStrings: false,
})

async function sqliteTransaction<T>(callback: () => Promise<T>): Promise<T> {
	sqliteDriver.exec('BEGIN IMMEDIATE')
	try {
		const result = await callback()
		sqliteDriver.exec('COMMIT')
		return result
	} catch (err) {
		if (sqliteDriver.inTransaction) sqliteDriver.exec('ROLLBACK')
		throw err
	}
}

async function getMySqlTableNames() {
	const [rows] = await mysqlConn.query(
		`SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ?`,
		[MYSQL_DATABASE],
	)
	return new Set((rows as { TABLE_NAME: string }[]).map((row) => row.TABLE_NAME))
}

async function getMySqlColumns(tableName: string) {
	const [rows] = await mysqlConn.query(
		`SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ORDINAL_POSITION`,
		[MYSQL_DATABASE, tableName],
	)
	return new Set((rows as { COLUMN_NAME: string }[]).map((row) => row.COLUMN_NAME))
}

function sqliteTableExists(tableName: string) {
	const row = sqliteDriver
		.prepare("select name from sqlite_master where type = 'table' and name = ?")
		.get(tableName)
	return !!row
}

function sqliteCount(tableName: string) {
	const row = sqliteDriver.prepare(`select count(*) as count from \`${tableName}\``).get() as { count: number }
	return Number(row.count)
}

const requiredSqliteTables = [
	'users',
	'filters',
	'filterUserContributors',
	'filterRoleContributors',
	'servers',
	'globalSettings',
	'matchHistory',
	'balanceTriggerEvents',
	'serverEvents',
	'players',
	'playerEventAssociations',
	'squads',
	'squadEventAssociations',
	'sessions',
	'persistedCache',
]

const missingSqliteTables = requiredSqliteTables.filter((table) => !sqliteTableExists(table))
if (missingSqliteTables.length > 0) {
	throw new Error(
		`SQLite database ${ENV.DB_PATH} is missing required tables: ${missingSqliteTables.join(', ')}. Apply the SQLite schema first.`,
	)
}

const mysqlTables = await getMySqlTableNames()
const mysqlColumns = new Map<string, Set<string>>()
for (const tableName of mysqlTables) {
	mysqlColumns.set(tableName, await getMySqlColumns(tableName))
}

logInfo('Starting MySQL → SQLite migration in %s mode', APPLY ? 'apply' : 'dry-run')
logInfo('MySQL source: %s@%s:%d/%s', MYSQL_USER, MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE)
logInfo('SQLite target: %s', ENV.DB_PATH)

const playerSteamToEos = new Map<string, string>()
const playerEosIds = new Set<string>()

async function fetchAllMySqlRows(tableName: string): Promise<SourceRow[]> {
	const [rows] = await mysqlConn.query(`SELECT * FROM \`${tableName}\``)
	return rows as SourceRow[]
}

async function fetchMySqlCount(tableName: string) {
	const [rows] = await mysqlConn.query(`SELECT COUNT(*) as count FROM \`${tableName}\``)
	return Number((rows as { count: number }[])[0]?.count ?? 0)
}

async function fetchMySqlBatch(tableName: string, columns: string[], orderBy: readonly string[] | null, offset: number, limit: number) {
	const selectList = columns.map((column) => `\`${column}\``).join(', ')
	const orderClause = orderBy && orderBy.length > 0 ? ` ORDER BY ${orderBy.map((column) => `\`${column}\``).join(', ')}` : ''
	const [rows] = await mysqlConn.query(`SELECT ${selectList} FROM \`${tableName}\`${orderClause} LIMIT ${limit} OFFSET ${offset}`)
	return rows as SourceRow[]
}

function reconcileSteamDuplicates(rows: SourceRow[]) {
	const grouped = new Map<string, SourceRow[]>()
	for (const row of rows) {
		if (row.steam64Id === null || row.steam64Id === undefined) continue
		const key = String(row.steam64Id)
		const existing = grouped.get(key) ?? []
		existing.push(row)
		grouped.set(key, existing)
	}

	let cleared = 0
	for (const [steam64Id, group] of grouped) {
		if (group.length <= 1) continue
		group.sort((a, b) => {
			const left = BigInt(String(a.discordId))
			const right = BigInt(String(b.discordId))
			return left < right ? -1 : left > right ? 1 : 0
		})
		const [keep, ...clear] = group
		logWarn(
			'users: duplicate steam64Id=%s found; keeping discordId=%s and clearing %d duplicates',
			steam64Id,
			keep.discordId,
			clear.length,
		)
		for (const row of clear) {
			row.steam64Id = null
			cleared += 1
		}
	}
	return cleared
}

function normalizeServerEventData(raw: unknown): unknown {
	const data = parseJsonValue<any>(raw)
	if (!data || typeof data !== 'object') return data
	const cloned = deepCloneJson(data)
	const payload = cloned?.json
	if (!payload || typeof payload !== 'object') return cloned

	const remapPlayerId = (value: unknown) => {
		if (!isLikelySteamLikeId(value)) return value
		return playerSteamToEos.get(value) ?? value
	}

	if ('player' in payload) payload.player = remapPlayerId(payload.player)
	if ('victim' in payload) payload.victim = remapPlayerId(payload.victim)
	if ('attacker' in payload) payload.attacker = remapPlayerId(payload.attacker)
	if (payload.squad && typeof payload.squad === 'object' && 'creator' in payload.squad) {
		payload.squad.creator = remapPlayerId(payload.squad.creator)
	}

	return cloned
}

const tableConfigs: TableMigration[] = [
	{
		name: 'users',
		targetName: 'users',
		target: Schema.users,
		orderBy: ['discordId'],
		prepareRows: async () => {
			if (!mysqlTables.has('users')) return []
			const rows = await fetchAllMySqlRows('users')
			const steamDeduped = reconcileSteamDuplicates(rows)
			if (steamDeduped > 0) logInfo('users: cleared duplicate steam64Id values on %d rows during import', steamDeduped)
			return rows.map((row) => ({
				discordId: toBigInt(row.discordId)!,
				steam64Id: toBigInt(row.steam64Id),
				username: String(row.username),
				nickname: row.nickname == null ? null : String(row.nickname),
			}))
		},
	},
	{
		name: 'players',
		targetName: 'players',
		target: Schema.players,
		orderBy: ['steamId'],
		prepareRows: async () => {
			if (!mysqlTables.has('players')) return []
			const rows = await fetchAllMySqlRows('players')
			const prepared = rows.map((row) => {
				const steamId = toBigInt(row.steamId)
				const eosId = String(row.eosId)
				if (steamId !== null) playerSteamToEos.set(String(steamId), eosId)
				playerEosIds.add(eosId)
				return {
					eosId,
					steamId,
					epicId: row.epicId == null ? null : String(row.epicId),
					username: String(row.username),
					usernameNoTag: row.usernameNoTag == null ? null : String(row.usernameNoTag),
					createdAt: toDate(row.createdAt),
					modifiedAt: toDate(row.modifiedAt),
				}
			})
			return prepared
		},
	},
	{
		name: 'filters',
		targetName: 'filters',
		target: Schema.filters,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => ({
			id: String(row.id),
			name: String(row.name),
			description: row.description == null ? null : String(row.description),
			filter: parseJsonValue(row.filter),
			owner: toBigInt(row.owner),
			alertMessage: row.alertMessage == null ? null : String(row.alertMessage),
			emoji: row.emoji == null ? null : String(row.emoji),
			invertedAlertMessage: row.invertedAlertMessage == null ? null : String(row.invertedAlertMessage),
			invertedEmoji: row.invertedEmoji == null ? null : String(row.invertedEmoji),
		}),
	},
	{
		name: 'filterUserContributors',
		targetName: 'filterUserContributors',
		target: Schema.filterUserContributors,
		orderBy: ['filterId', 'userId'],
		transformRow: (row: SourceRow) => ({
			filterId: String(row.filterId),
			userId: toBigInt(row.userId)!,
		}),
	},
	{
		name: 'filterRoleContributors',
		targetName: 'filterRoleContributors',
		target: Schema.filterRoleContributors,
		orderBy: ['filterId', 'roleId'],
		transformRow: (row: SourceRow) => ({
			filterId: String(row.filterId),
			roleId: String(row.roleId),
		}),
	},
	{
		name: 'servers',
		targetName: 'servers',
		target: Schema.servers,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => ({
			id: String(row.id),
			displayName: String(row.displayName),
			enabled: toBoolean(row.enabled) ?? true,
			defaultServer: toBoolean(row.defaultServer) ?? false,
			layerQueue: row.layerQueue == null ? undefined : parseJsonValue(row.layerQueue),
			teamswitches: row.teamswitches == null ? undefined : parseJsonValue(row.teamswitches),
			settings: row.settings == null ? null : parseJsonValue(row.settings),
		}),
	},
	{
		name: 'globalSettings',
		targetName: 'globalSettings',
		target: Schema.globalSettings,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => ({
			id: toNumber(row.id) ?? 1,
			settings: parseJsonValue(row.settings) ?? {},
		}),
	},
	{
		name: 'matchHistory',
		targetName: 'matchHistory',
		target: Schema.matchHistory,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => ({
			id: toNumber(row.id)!,
			serverId: String(row.serverId),
			ordinal: toNumber(row.ordinal)!,
			layerId: String(row.layerId),
			rawLayerCommandText: row.rawLayerCommandText == null ? null : String(row.rawLayerCommandText),
			lqItemId: row.lqItemId == null ? null : String(row.lqItemId),
			startTime: toDate(row.startTime),
			endTime: toDate(row.endTime),
			createdAt: toDate(row.createdAt),
			outcome: row.outcome == null ? null : String(row.outcome),
			team1Tickets: toNumber(row.team1Tickets),
			team2Tickets: toNumber(row.team2Tickets),
			setByType: String(row.setByType),
			setByUserId: toBigInt(row.setByUserId),
		}),
	},
	{
		name: 'balanceTriggerEvents',
		targetName: 'balanceTriggerEvents',
		target: Schema.balanceTriggerEvents,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => ({
			id: toNumber(row.id)!,
			triggerId: String(row.triggerId),
			triggerVersion: toNumber(row.triggerVersion)!,
			matchTriggeredId: toNumber(row.matchTriggeredId),
			strongerTeam: String(row.strongerTeam),
			level: String(row.level),
			evaluationResult: parseJsonValue(row.evaluationResult),
		}),
	},
	{
		name: 'serverEvents',
		targetName: 'serverEvents',
		target: Schema.serverEvents,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => ({
			id: toNumber(row.id)!,
			type: String(row.type),
			time: toDate(row.time)!,
			matchId: toNumber(row.matchId)!,
			version: toNumber(row.version),
			data: normalizeServerEventData(row.data),
		}),
	},
	{
		name: 'playerEventAssociations',
		targetName: 'playerEventAssociations',
		target: Schema.playerEventAssociations,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => {
			let playerId = row.playerId == null ? null : String(row.playerId)
			if (playerId && !playerEosIds.has(playerId) && playerSteamToEos.has(playerId)) {
				playerId = playerSteamToEos.get(playerId)!
			}
			if (!playerId || !playerEosIds.has(playerId)) {
				logWarn('playerEventAssociations: skipping row with unresolved playerId=%s (serverEventId=%s)', row.playerId, row.serverEventId)
				return null
			}
			return {
				id: toNumber(row.id) ?? undefined,
				serverEventId: toNumber(row.serverEventId)!,
				playerId,
				assocType: String(row.assocType),
				createdAt: toDate(row.createdAt),
			}
		},
		insert: async (rows: typeof Schema.playerEventAssociations.$inferInsert[]) => {
			if (rows.length === 0) return
			await sqliteDb.insert(Schema.playerEventAssociations).values(rows).onConflictDoNothing({
				target: [
					Schema.playerEventAssociations.serverEventId,
					Schema.playerEventAssociations.playerId,
					Schema.playerEventAssociations.assocType,
				],
			})
		},
	},
	{
		name: 'squads',
		targetName: 'squads',
		target: Schema.squads,
		orderBy: ['id'],
		transformRow: (row: SourceRow) => {
			let creatorId = row.creatorId == null ? null : String(row.creatorId)
			if (creatorId && !playerEosIds.has(creatorId) && playerSteamToEos.has(creatorId)) {
				creatorId = playerSteamToEos.get(creatorId)!
			}
			if (creatorId && !playerEosIds.has(creatorId)) creatorId = null
			return {
				id: toNumber(row.id)!,
				ingameSquadId: toNumber(row.ingameSquadId)!,
				teamId: toNumber(row.teamId)!,
				name: String(row.name),
				creatorId,
				createdAt: toDate(row.createdAt),
			}
		},
	},
	{
		name: 'squadEventAssociations',
		targetName: 'squadEventAssociations',
		target: Schema.squadEventAssociations,
		orderBy: ['serverEventId', 'squadId'],
		transformRow: (row: SourceRow) => ({
			serverEventId: toNumber(row.serverEventId)!,
			squadId: toNumber(row.squadId)!,
			createdAt: toDate(row.createdAt),
		}),
		insert: async (rows: typeof Schema.squadEventAssociations.$inferInsert[]) => {
			if (rows.length === 0) return
			await sqliteDb.insert(Schema.squadEventAssociations).values(rows).onConflictDoNothing({
				target: [Schema.squadEventAssociations.serverEventId, Schema.squadEventAssociations.squadId],
			})
		},
	},
	{
		name: 'sessions',
		targetName: 'sessions',
		target: Schema.sessions,
		orderBy: ['session'],
		transformRow: (row: SourceRow) => ({
			id: String(row.session ?? row.id),
			userId: toBigInt(row.userId)!,
			expiresAt: toDate(row.expiresAt)!,
		}),
	},
	{
		name: 'persistedCache',
		targetName: 'persistedCache',
		target: Schema.persistedCache,
		orderBy: ['key'],
		transformRow: (row: SourceRow) => ({
			key: String(row.key),
			value: parseJsonValue(row.value),
			updatedAt: toDate(row.updatedAt)!,
		}),
	},
]

async function ensureTargetReady() {
	const nonEmpty = requiredSqliteTables
		.map((tableName) => ({ tableName, count: sqliteCount(tableName) }))
		.filter((row) => row.count > 0)

	if (nonEmpty.length === 0) return
	if (!APPLY) {
		logWarn('SQLite target is not empty (dry-run only): %s', nonEmpty.map((row) => `${row.tableName}=${row.count}`).join(', '))
		return
	}
	if (!TRUNCATE_TARGET) {
		throw new Error(
			`SQLite target is not empty: ${
				nonEmpty.map((row) => `${row.tableName}=${row.count}`).join(', ')
			}. Re-run with --truncate-target to clear it first.`,
		)
	}

	logWarn('Truncating existing SQLite target data')
	sqliteDriver.pragma('foreign_keys = OFF')
	for (const tableName of requiredSqliteTables) {
		sqliteDriver.prepare(`DELETE FROM \`${tableName}\``).run()
	}
	sqliteDriver.pragma('foreign_keys = ON')
}

async function insertDefault(rows: any[], table: any) {
	if (rows.length === 0) return
	await sqliteDb.insert(table).values(rows)
}

async function migrateConfig(config: TableMigration) {
	if (!mysqlTables.has(config.name)) {
		logWarn('Skipping %s: source table not found in MySQL', config.name)
		return
	}

	if (config.prepareRows) {
		const prepared = await config.prepareRows()
		logInfo('%s: prepared %d rows from source', config.name, prepared.length)
		if (!APPLY || prepared.length === 0) return
		for (let i = 0; i < prepared.length; i += CHUNK_SIZE) {
			const chunk = prepared.slice(i, i + CHUNK_SIZE)
			if (config.insert) await config.insert(chunk)
			else await insertDefault(chunk, config.target)
		}
		return
	}

	const sourceColumnSet = mysqlColumns.get(config.name) ?? new Set<string>()
	const count = await fetchMySqlCount(config.name)
	logInfo('%s: source has %d rows', config.name, count)
	if (!APPLY || count === 0) return

	const allColumns = Array.from(sourceColumnSet)
	for (let offset = 0; offset < count; offset += CHUNK_SIZE) {
		const batch = await fetchMySqlBatch(config.name, allColumns, config.orderBy, offset, CHUNK_SIZE)
		const prepared = batch.map((row) => config.transformRow!(row)).filter(Boolean)
		if (prepared.length === 0) continue
		if (config.insert) await config.insert(prepared)
		else await insertDefault(prepared, config.target)
	}
}

try {
	await ensureTargetReady()

	// Populate player identity maps before dependent transforms run.
	const playerConfig = tableConfigs.find((config) => config.name === 'players')!
	if ('prepareRows' in playerConfig && playerConfig.prepareRows) {
		const previewPlayers = await playerConfig.prepareRows()
		logInfo('players: previewed %d rows and built identity maps', previewPlayers.length)
		if (APPLY && previewPlayers.length > 0) {
			await sqliteTransaction(async () => {
				for (let i = 0; i < previewPlayers.length; i += CHUNK_SIZE) {
					await insertDefault(previewPlayers.slice(i, i + CHUNK_SIZE), Schema.players)
				}
			})
		}
	}

	for (const config of tableConfigs) {
		if (config.name === 'players') continue
		await sqliteTransaction(async () => {
			await migrateConfig(config)
		})
	}

	if (APPLY) {
		logInfo('MySQL → SQLite migration completed successfully')
	} else {
		logInfo('Dry run complete. Re-run with --apply to perform the migration.')
	}
} finally {
	await mysqlConn.end()
	sqliteDriver.close()
}
