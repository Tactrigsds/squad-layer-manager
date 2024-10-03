import * as C from '@/lib/constants'
import * as M from '@/models'
import { db, setupDatabase } from '@/server/db'
import * as Schema from '@/server/schema'
import { parse } from 'csv-parse/sync'
import dotenv from 'dotenv'
import { sql } from 'drizzle-orm'
import * as fs from 'fs'
import { z } from 'zod'

dotenv.config()
setupDatabase()

// Define the schema for raw data

export const RawLayerSchema = z.object({
	Level: z.string(),
	Layer: z.string(),
	Size: z.string(),
	Faction_1: z.string(),
	SubFac_1: z.string(),
	Logistics_1: z.number(),
	Transportation_1: z.number(),
	'Anti-Infantry_1': z.number(),
	Armor_1: z.number(),
	ZERO_Score_1: z.number(),
	Faction_2: z.string(),
	SubFac_2: z.string(),
	Logistics_2: z.number(),
	Transportation_2: z.number(),
	'Anti-Infantry_2': z.number(),
	Armor_2: z.number(),
	ZERO_Score_2: z.number(),
	Balance_Differential: z.number(),
	'Asymmetry Score': z.number(),
})

function processLayer(rawLayer: z.infer<typeof RawLayerSchema>, numRecords: number): M.Layer {
	const [_, gamemode, version] = rawLayer.Layer.split('_')
	const id = M.getLayerId({
		Level: rawLayer.Level,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: rawLayer.Faction_1,
		SubFac_1: rawLayer.SubFac_1,
		Faction_2: rawLayer.Faction_2,
		SubFac_2: rawLayer.SubFac_2,
	})

	return {
		id,
		randomOrdinal: Math.floor(Math.random() * numRecords),
		Level: rawLayer.Level,
		Layer: rawLayer.Layer,
		Size: rawLayer.Size,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: rawLayer.Faction_1,
		SubFac_1: rawLayer.SubFac_1 as C.Subfaction,
		Logistics_1: rawLayer.Logistics_1,
		Transportation_1: rawLayer.Transportation_1,
		'Anti-Infantry_1': rawLayer['Anti-Infantry_1'],
		Armor_1: rawLayer.Armor_1,
		ZERO_Score_1: rawLayer.ZERO_Score_1,
		Faction_2: rawLayer.Faction_2,
		SubFac_2: rawLayer.SubFac_2 as C.Subfaction,
		Logistics_2: rawLayer.Logistics_2,
		Transportation_2: rawLayer.Transportation_2,
		'Anti-Infantry_2': rawLayer['Anti-Infantry_2'],
		Armor_2: rawLayer.Armor_2,
		ZERO_Score_2: rawLayer.ZERO_Score_2,
		Balance_Differential: rawLayer.Balance_Differential,
		'Asymmetry Score': rawLayer['Asymmetry Score'],
		Logistics_Diff: rawLayer.Logistics_1 - rawLayer.Logistics_2,
		Transportation_Diff: rawLayer.Transportation_1 - rawLayer.Transportation_2,
		'Anti-Infantry_Diff': rawLayer['Anti-Infantry_1'] - rawLayer['Anti-Infantry_2'],
		Armor_Diff: rawLayer.Armor_1 - rawLayer.Armor_2,
		ZERO_Score_Diff: rawLayer.ZERO_Score_1 - rawLayer.ZERO_Score_2,
	}
}

async function main() {
	const t0 = performance.now()
	const csvData = fs.readFileSync('layers.csv', 'utf8')
	const records = parse(csvData, { columns: true, skip_empty_lines: true }) as Record<string, string>[]
	const t1 = performance.now()
	const elapsedSecondsParse = (t1 - t0) / 1000

	if (records.length === 0) {
		throw new Error('No records found in CSV file')
	}

	const originalNumericFields = [...M.COLUMN_TYPE_MAPPINGS.float, ...M.COLUMN_TYPE_MAPPINGS.integer].filter((field) => field in records[0])
	const processedLayers = records.map((record, index) => {
		const updatedRecord = { ...record } as { [key: string]: number | string }
		originalNumericFields.forEach((field) => {
			if (!record[field]) {
				throw new Error(`Missing value for field ${field}: rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
			if (M.COLUMN_KEY_TO_TYPE[field] === 'integer') updatedRecord[field] = parseInt(record[field])
			else updatedRecord[field] = parseFloat(record[field])
			if (isNaN(updatedRecord[field] as number)) {
				throw new Error(`Invalid value for field ${field}: ${record[field]} rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
		})

		const validatedRawLayer = RawLayerSchema.parse(updatedRecord)
		return processLayer(validatedRawLayer, records.length)
	})
	console.log(`Parsing CSV took ${elapsedSecondsParse} s`)

	const t2 = performance.now()

	// truncate the table
	console.log('Truncating layers table')
	await db.execute(sql`
	TRUNCATE TABLE ${Schema.layers}

	`)
	console.log('layers table truncated')
	console.log('inserting layers')
	// Insert the processed layers
	const chunkSize = 2500
	for (let i = 0; i < processedLayers.length; i += chunkSize) {
		const chunk = processedLayers.slice(i, i + chunkSize)
		await db.insert(Schema.layers).values(chunk)
		console.log(`Inserted ${i + chunk.length} rows`)
	}

	const t3 = performance.now()
	const elapsedSecondsInsert = (t3 - t2) / 1000
	console.log(`Inserting ${processedLayers.length} rows took ${elapsedSecondsInsert} s`)
}

await main()

process.exit(0)
