import { wrapColName } from '@/lib/sql'
import * as M from '@/models'
import * as DB from '@/server/db'
import { parse } from 'csv-parse/sync'
import * as fs from 'fs'

function processLayer(rawLayer: M.RawLayer): M.Layer {
	const [_, gamemode, version] = rawLayer.Layer.split('_')
	const Id = M.getLayerId({
		Level: rawLayer.Level,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: rawLayer.Faction_1,
		SubFac_1: rawLayer.SubFac_1,
		Faction_2: rawLayer.Faction_2,
		SubFac_2: rawLayer.SubFac_2,
	})

	return {
		Id,
		RandomOrdinal: Math.floor(Math.random() * records.length),
		...rawLayer,
		Gamemode: gamemode,
		LayerVersion: version,
		Logistics_Diff: rawLayer.Logistics_1 - rawLayer.Logistics_2,
		Transportation_Diff: rawLayer.Transportation_1 - rawLayer.Transportation_2,
		'Anti-Infantry_Diff': rawLayer['Anti-Infantry_1'] - rawLayer['Anti-Infantry_2'],
		Armor_Diff: rawLayer.Armor_1 - rawLayer.Armor_2,
		ZERO_Score_Diff: rawLayer.ZERO_Score_1 - rawLayer.ZERO_Score_2,
	}
}

const csvData = fs.readFileSync('layers.csv', 'utf8')
const records = parse(csvData, { columns: true, skip_empty_lines: true }) as Record<string, string>[]

if (records.length === 0) {
	throw new Error('No records found in CSV file')
}

const originalNumericFields = [...M.COLUMN_TYPE_MAPPINGS.float, ...M.COLUMN_TYPE_MAPPINGS.integer].filter(
	(field) => field in M.RawLayerSchema.shape
)

const processedLayers: M.Layer[] = records
	.map((record, index) => {
		const updatedRecord = record as Record<string, string | number>
		originalNumericFields.forEach((field) => {
			// WARNING mutates original record as well
			if (!record[field]) {
				throw new Error(`Missing value for field ${field}: rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
			if (M.COLUMN_KEY_TO_TYPE[field] === 'integer') updatedRecord[field] = parseInt(record[field])
			else updatedRecord[field] = parseFloat(record[field])
			if (isNaN(updatedRecord[field] as number)) {
				throw new Error(`Invalid value for field ${field}: ${record[field]} rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
		})

		const validatedRawLayer = M.RawLayerSchema.parse(record)
		return processLayer(validatedRawLayer)
	})
	.map((layer) => M.ProcessedLayerSchema.strict().parse(layer))

const db = await DB.openConnection()

const colKeys = M.COLUMN_KEYS
const colDefs: string[] = []

for (const key of M.COLUMN_KEYS) {
	if (key === 'Id') {
		colDefs.push('Id TEXT NOT NULL PRIMARY KEY')
		continue
	}
	const columnType = M.COLUMN_KEY_TO_TYPE[key]
	switch (columnType) {
		case 'float':
			colDefs.push(`${wrapColName(key)} REAL`)
			break
		case 'string':
			colDefs.push(`${wrapColName(key)} TEXT`)
			break
		case 'integer':
			colDefs.push(`${wrapColName(key)} INTEGER`)
	}
}

await db.run(`DROP TABLE IF EXISTS layers`)
const createTableStmt = `CREATE TABLE layers (${colDefs.join(', ')})`
console.log('createTable', createTableStmt)
await db.run(createTableStmt)

const t0 = performance.now()
await db.run('BEGIN TRANSACTION')
try {
	const query = `INSERT INTO layers VALUES (${colDefs.map(() => '?').join(', ')})`
	console.log(query)
	const stmt = await db.prepare(query)
	const ops: Promise<unknown>[] = []
	for (const layer of processedLayers) {
		ops.push(
			stmt.run(
				...colKeys.map((col) => {
					return layer[col as M.LayerColumnKey]
				})
			)
		)
	}
	await Promise.all(ops)
	await stmt.finalize()
} catch (e) {
	db.run('ROLLBACK')
	throw e
}

await db.run('COMMIT')
const t1 = performance.now()

const elapsedSeconds = (t1 - t0) / 1000
console.log(`Inserting ${processedLayers.length} rows took ${elapsedSeconds} s`)
db.close()
