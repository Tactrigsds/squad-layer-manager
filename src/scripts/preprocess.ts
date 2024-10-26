import { parse } from 'csv-parse/sync'
import { sql } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import * as fs from 'fs'
import path from 'path'
import { z } from 'zod'

import { resolvePromises } from '@/lib/async'
import * as C from '@/lib/constants'
import { deref as derefEntries } from '@/lib/object'
import * as M from '@/models'
import { PROJECT_ROOT } from '@/server/config'
import * as DB from '@/server/db'
import { setupEnv } from '@/server/env'
import { Logger, baseLogger, setupLogger } from '@/server/logger'
import * as Schema from '@/server/schema'

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

async function main() {
	setupEnv()
	await setupLogger()
	DB.setupDatabase()
	const log = baseLogger.child({ module: 'preprocess' })
	const db = DB.get({ log })
	const ctx = { log, db }
	// await updateLayersTable(ctx)
	await updateLayerComponents(ctx)
}

function processLayer(rawLayer: z.infer<typeof RawLayerSchema>): M.Layer {
	const { gamemode, version } = M.parseLayerString(rawLayer.Layer)
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

async function updateLayersTable({ db, log }: Context) {
	const t0 = performance.now()
	baseLogger.info('Reading layers.csv..')
	const csvData = fs.readFileSync('layers.csv', 'utf8')
	// TODO can optimize by pulling out rows incrementally
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
		return processLayer(validatedRawLayer)
	})
	log.info(`Parsing CSV took ${elapsedSecondsParse} s`)

	const t2 = performance.now()

	// truncate the table
	log.info('Truncating layers table')
	await db.execute(sql`
	TRUNCATE TABLE ${Schema.layers}

	`)
	log.info('layers table truncated')
	log.info('inserting layers')
	// Insert the processed layers
	const chunkSize = 2500
	for (let i = 0; i < processedLayers.length; i += chunkSize) {
		const chunk = processedLayers.slice(i, i + chunkSize)
		await db.insert(Schema.layers).values(chunk)
		log.info(`Inserted ${i + chunk.length} rows`)
	}

	// add jensens range layers
	const extraJensensLayers: M.Layer[] = [
		'JensensRange_ADF-PLA',
		'JensensRange_BAF-IMF',
		'JensensRange_CAF-INS',
		'JensensRange_PLANMC-VDV',
		'JensensRange_USA-RGF',
		'JensensRange_USA-TLF',
		'JensensRange_USMC-MEA',
	].map((layer) => {
		const [level, factions] = layer.split('_')
		const [faction1, faction2] = factions.split('-')
		return {
			id: M.getLayerId({
				Level: level,
				Gamemode: 'Training',
				LayerVersion: null,
				Faction_1: faction1,
				SubFac_1: null,
				Faction_2: faction2,
				SubFac_2: null,
			}),
			Level: level,
			Layer: layer,
			Size: 'Small',
			Gamemode: 'Training',
			LayerVersion: null,
			Faction_1: faction1,
			SubFac_1: null,
			Faction_2: faction2,
			SubFac_2: null,
			Logistics_1: 0,
			Transportation_1: 0,
			'Anti-Infantry_1': 0,
			Armor_1: 0,
			ZERO_Score_1: 0,
			Logistics_2: 0,
			Transportation_2: 0,
			'Anti-Infantry_2': 0,
			Armor_2: 0,
			ZERO_Score_2: 0,
			Balance_Differential: 0,
			'Asymmetry Score': 0,
			Logistics_Diff: 0,
			Transportation_Diff: 0,
			'Anti-Infantry_Diff': 0,
			Armor_Diff: 0,
			ZERO_Score_Diff: 0,
		}
	})

	await db.insert(Schema.layers).values(extraJensensLayers)
	log.info(`Inserted ${extraJensensLayers.length} extra Jensen's Range layers`)

	const t3 = performance.now()
	const elapsedSecondsInsert = (t3 - t2) / 1000
	log.info(`Inserting ${processedLayers.length} rows took ${elapsedSecondsInsert} s`)
}

type Context = {
	log: Logger
	db: DB.Db
}

async function updateLayerComponents({ db, log }: Context) {
	const factionsPromise = db
		.select({ faction: Schema.layers.Faction_1 })
		.from(Schema.layers)
		.groupBy(Schema.layers.Faction_1)
		.then((result) => derefEntries('faction', result))

	const subfactionsPromise = db
		.select({ subfaction: Schema.layers.SubFac_1 })
		.from(Schema.layers)
		.groupBy(Schema.layers.SubFac_1)
		.then((result) => derefEntries('subfaction', result))

	const levelsPromise = db
		.select({ level: Schema.layers.Level })
		.from(Schema.layers)
		.groupBy(Schema.layers.Level)
		.then((result) => derefEntries('level', result))

	const layersPromise = db
		.select({ layer: Schema.layers.Layer })
		.from(Schema.layers)
		.groupBy(Schema.layers.Layer)
		.then((result) => derefEntries('layer', result))

	const layerVersionsPromise = db
		.select({ version: Schema.layers.LayerVersion })
		.from(Schema.layers)
		.groupBy(Schema.layers.LayerVersion)
		.then((result) => derefEntries('version', result))

	for (const level of await levelsPromise) {
		if (!(level in LEVEL_SHORT_NAMES)) throw new Error(`level ${level} doesn't have a short name`)
		if (!(level in LEVEL_ABBREVIATIONS)) throw new Error(`level ${level} doesn't have an abbreviation`)
	}
	for (const subfaction of await subfactionsPromise) {
		if (subfaction === null) continue
		if (!(subfaction in SUBFACTION_ABBREVIATIONS)) throw new Error(`subfaction ${subfaction} doesn't have an abbreviation`)
		if (!(subfaction in SUBFACTION_SHORT_NAMES)) throw new Error(`subfaction ${subfaction} doesn't have a short name`)
	}

	const layerComponents = await resolvePromises({
		factions: factionsPromise,
		subfactions: subfactionsPromise,
		subfactionAbbreviations: SUBFACTION_ABBREVIATIONS,
		subfactionShortNames: SUBFACTION_SHORT_NAMES,
		levels: levelsPromise,
		levelAbbreviations: LEVEL_ABBREVIATIONS,
		levelShortNames: LEVEL_SHORT_NAMES,
		layers: layersPromise,
		layerVersions: layerVersionsPromise,
	})

	fs.writeFileSync(path.join(PROJECT_ROOT, 'src', 'assets', 'layer-components.json'), JSON.stringify(layerComponents, null, 2))
	log.info(
		'Updated layer-components.json with %d factions, %d subfactions, %d levels, %d layers, and %d layer versions',
		layerComponents.factions.length,
		layerComponents.subfactions.length,
		layerComponents.levels.length,
		layerComponents.layers.length,
		layerComponents.layerVersions.length
	)
	if (!deepEqual(C.SUBFACTIONS, layerComponents.subfactions)) {
		throw new Error(
			`SUBFACTIONS should match the output of layerComponents, instead got SUBFACTIONS: ${C.SUBFACTIONS.join(', ')}, ${layerComponents.subfactions.join(', ')}`
		)
	}
}

const LEVEL_ABBREVIATIONS = {
	AlBasrah: 'AB',
	Anvil: 'AN',
	Belaya: 'BL',
	BlackCoast: 'BC',
	Chora: 'CH',
	Fallujah: 'FL',
	FoolsRoad: 'FR',
	GooseBay: 'GB',
	Gorodok: 'GD',
	Harju: 'HJ',
	Kamdesh: 'KD',
	Kohat: 'KH',
	Kokan: 'KK',
	Lashkar: 'LK',
	Logar: 'LG',
	Manicouagan: 'MN',
	Mestia: 'MS',
	Mutaha: 'MT',
	Narva: 'NV',
	PacificProvingGrounds: 'PPG',
	Sanxian: 'SX',
	Skorpo: 'SK',
	Sumari: 'SM',
	Tallil: 'TL',
	Yehorivka: 'YH',
	JensensRange: 'JR',
} as Record<string, string>

const SUBFACTION_ABBREVIATIONS = {
	AirAssault: 'AA',
	Armored: 'AR',
	CombinedArms: 'CA',
	LightInfantry: 'LI',
	Mechanized: 'MZ',
	Motorized: 'MT',
	Support: 'SP',
} as Record<string, string>

export const LEVEL_SHORT_NAMES: Record<M.Layer['Level'], string> = {
	AlBasrah: 'Basrah',
	Anvil: 'Anvil',
	Belaya: 'Belaya',
	BlackCoast: 'Coast',
	Chora: 'Chora',
	Fallujah: 'Fallu',
	FoolsRoad: 'Fools',
	GooseBay: 'Goose',
	Gorodok: 'Goro',
	Harju: 'Harju',
	Kamdesh: 'Kamdesh',
	Kohat: 'Kohat',
	Kokan: 'Kokan',
	Lashkar: 'Lashkar',
	Logar: 'Logar',
	Manicouagan: 'Manic',
	Mestia: 'Mestia',
	Mutaha: 'Muta',
	Narva: 'Narva',
	PacificProvingGrounds: 'PPG',
	Sanxian: 'Sanxian',
	Skorpo: 'Skorpo',
	Sumari: 'Sumari',
	Tallil: 'Tallil',
	Yehorivka: 'Yeho',
	JensensRange: 'Jensens',
}

const SUBFACTION_SHORT_NAMES = {
	CombinedArms: 'Combined',
	Armored: 'Armored',
	LightInfantry: 'Light',
	Mechanized: 'Mech',
	Motorized: 'Motor',
	Support: 'Sup',
	AirAssault: 'Air',
} satisfies Record<M.Subfaction, string>

await main()

process.exit(0)
