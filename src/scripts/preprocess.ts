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

const originalNumericFields = M.COLUMN_TYPE_MAPPINGS.numeric.filter((field) => field in M.RawLayerSchema.shape)

const processedLayers: M.Layer[] = records
	.map((record, index) => {
		const updatedRecord = record as Record<string, string | number>
		originalNumericFields.forEach((field) => {
			// WARNING mutates original record as well
			if (!record[field]) {
				throw new Error(`Missing value for field ${field}: rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
			updatedRecord[field] = parseFloat(record[field])
			if (isNaN(updatedRecord[field] as number)) {
				throw new Error(`Invalid value for field ${field}: ${record[field]} rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
		})

		const validatedRawLayer = M.RawLayerSchema.parse(record)
		return processLayer(validatedRawLayer)
	})
	.map((layer) => M.ProcessedLayerSchema.strict().parse(layer))

const db = await DB.openConnection()

// we have this defined in models but we don't want to introduce an ordering dependency over there if we don't have to
const colKeys = [...M.COLUMN_TYPE_MAPPINGS.string, ...M.COLUMN_TYPE_MAPPINGS.numeric]
const colDefs = [
	...M.COLUMN_TYPE_MAPPINGS.string.map((col) => `${wrapColName(col)} TEXT`),
	...M.COLUMN_TYPE_MAPPINGS.numeric.map((col) => `${wrapColName(col)} REAL`),
]

await db.run(`DROP TABLE IF EXISTS layers`)
const createTableStmt = `CREATE TABLE layers (${colDefs.join(', ')})`
await db.run(createTableStmt)

const t0 = performance.now()
await db.run('BEGIN TRANSACTION')
try {
	const stmt = await db.prepare(`INSERT INTO layers VALUES (${colKeys.map(() => '?').join(', ')})`)
	const ops: Promise<unknown>[] = []
	for (const layer of processedLayers) {
		ops.push(stmt.run(...colKeys.map((col) => layer[col])))
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
