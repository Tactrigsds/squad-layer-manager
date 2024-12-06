import * as SquadPipelineModels from '@/lib/squad-pipeline/squad-pipeline-models.ts'
import { sql } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import * as fs from 'fs'
import { parse } from 'csv-parse/sync'
import * as fsPromise from 'fs/promises'
import path from 'path'
import stringifyCompact from 'json-stringify-pretty-compact'
import { z } from 'zod'

import { zodToJsonSchema } from 'zod-to-json-schema'
import { resolvePromises } from '@/lib/async'
import * as Constants from '@/lib/constants'
import { deref as derefEntries } from '@/lib/object'
import * as M from '@/models'
import * as Config from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { setupEnv } from '@/server/env'
import { baseLogger, setupLogger } from '@/server/logger'
import * as Schema from '@/server/schema'
import * as Paths from '@/server/paths'
import { Alliance, Biome, BIOME_FACTIONS } from '@/lib/rcon/squad-models'

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
	await using ctx = C.pushOperation(DB.addPooledDb({ log: baseLogger }), 'preprocess')

	await generateConfigJsonSchema(ctx)
	const alliances = await parseAlliances(ctx)
	const biomes = await parseBiomes(ctx)

	await downloadPipeline(ctx)
	const pipeline = await parsePipelineData()
	await updateLayersTable(ctx, pipeline, alliances, biomes)
	await updateLayerComponents(ctx)
}

async function downloadPipeline(_ctx: C.Log) {
	await using ctx = C.pushOperation(_ctx, 'download-pipeline')
	const res = await fetch(
		'https://raw.githubusercontent.com/Squad-Wiki/squad-wiki-pipeline-map-data/refs/heads/master/completed_output/_Current%20Version/finished.json'
	)
	const data = await res.json()
	await fsPromise.writeFile(path.join(Paths.DATA, 'squad-pipeline.json'), JSON.stringify(data, null, 2))
	ctx.log.info('Downloaded squad pipeline data')
}

function processLayer(rawLayer: z.infer<typeof RawLayerSchema>): M.Layer {
	const { gamemode, version: version } = M.parseLayerString(rawLayer.Layer)
	const level = M.preprocessLevel(rawLayer.Level)
	const id = M.getLayerId({
		Level: level,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: rawLayer.Faction_1,
		SubFac_1: rawLayer.SubFac_1,
		Faction_2: rawLayer.Faction_2,
		SubFac_2: rawLayer.SubFac_2,
	})

	return {
		id,
		Level: level,
		Layer: rawLayer.Layer,
		Size: rawLayer.Size,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: rawLayer.Faction_1,
		SubFac_1: rawLayer.SubFac_1 as Constants.Subfaction,
		Logistics_1: rawLayer.Logistics_1,
		Transportation_1: rawLayer.Transportation_1,
		'Anti-Infantry_1': rawLayer['Anti-Infantry_1'],
		Armor_1: rawLayer.Armor_1,
		ZERO_Score_1: rawLayer.ZERO_Score_1,
		Faction_2: rawLayer.Faction_2,
		SubFac_2: rawLayer.SubFac_2 as Constants.Subfaction,
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

async function parsePipelineData() {
	return await fsPromise
		.readFile(path.join(Paths.DATA, 'squad-pipeline.json'), 'utf8')
		.then((data) => SquadPipelineModels.PipelineOutputSchema.parse(JSON.parse(data)))
}

async function updateLayersTable(_ctx: C.Log & C.Db, pipeline: SquadPipelineModels.PipelineOutput, alliances: Alliance[], biomes: Biome[]) {
	using ctx = C.pushOperation(_ctx, 'update-layers-table')
	const t0 = performance.now()
	const seedLayers: M.Layer[] = getSeedingLayers(pipeline, biomes, alliances)

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

	baseLogger.info('Reading layers.csv..')
	const csvData = await fsPromise.readFile(path.join(Paths.DATA, 'layers.csv'), 'utf8')
	// TODO can optimize by pulling out rows incrementally
	const records = parse(csvData, { columns: true, skip_empty_lines: true }) as Record<string, string>[]
	const t1 = performance.now()
	const elapsedSecondsParse = (t1 - t0) / 1000

	if (records.length === 0) {
		throw new Error('No records found in CSV file')
	}

	const originalNumericFields = [...M.COLUMN_TYPE_MAPPINGS.float, ...M.COLUMN_TYPE_MAPPINGS.integer].filter((field) => field in records[0])
	let processedLayers = records.map((record, index) => {
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
	processedLayers = [...processedLayers, ...seedLayers, ...extraJensensLayers]
	ctx.log.info(`Parsing CSV took ${elapsedSecondsParse} s`)

	const t2 = performance.now()

	// truncate the table
	ctx.log.info('Truncating layers table')
	await ctx.db().execute(sql`TRUNCATE TABLE ${Schema.layers} `)
	ctx.log.info('inserting layers')
	// Insert the processed layers
	const chunkSize = 2500
	for (let i = 0; i < processedLayers.length; i += chunkSize) {
		const chunk = processedLayers.slice(i, i + chunkSize)
		await ctx.db().insert(Schema.layers).values(chunk)
		ctx.log.info(`Inserted ${i + chunk.length} rows`)
	}

	const t3 = performance.now()
	const elapsedSecondsInsert = (t3 - t2) / 1000
	ctx.log.info(`Inserting ${processedLayers.length} rows took ${elapsedSecondsInsert} s`)
}

function getSeedingLayers(pipeline: SquadPipelineModels.PipelineOutput, biomes: Biome[], alliances: Alliance[]) {
	const seedLayers: M.Layer[] = []
	for (const layer of pipeline.Maps) {
		if (!layer.levelName.toLowerCase().includes('seed')) continue
		const mapName = M.preprocessLevel(layer.mapId)

		const matchups = getSeedingMatchupsForLayer(layer.mapName, alliances, biomes)
		for (const [team1, team2] of matchups) {
			seedLayers.push({
				id: M.getLayerId({
					Level: mapName,
					Gamemode: layer.gamemode,
					LayerVersion: layer.layerVersion.toUpperCase(),
					Faction_1: team1,
					SubFac_1: null,
					Faction_2: team2,
					SubFac_2: null,
				}),
				Level: mapName,
				Layer: layer.levelName,
				Size: layer.mapSize,
				Gamemode: layer.gamemode,
				LayerVersion: layer.layerVersion.toUpperCase(),
				Faction_1: team1,
				SubFac_1: null,
				Faction_2: team2,
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
			})
		}
	}
	return seedLayers
}

async function updateLayerComponents(_ctx: C.Log & C.Db) {
	using ctx = C.pushOperation(_ctx, 'update-layer-components')
	const factionsPromise = ctx
		.db()
		.select({ faction: Schema.layers.Faction_1 })
		.from(Schema.layers)
		.groupBy(Schema.layers.Faction_1)
		.then((result) => derefEntries('faction', result))

	const subfactionsPromise = ctx
		.db()
		.select({ subfaction: Schema.layers.SubFac_1 })
		.from(Schema.layers)
		.groupBy(Schema.layers.SubFac_1)
		.then((result) => derefEntries('subfaction', result))
		.then((subfactions) => subfactions.filter((sf) => sf !== null))

	const levelsPromise = ctx
		.db()
		.select({ level: Schema.layers.Level })
		.from(Schema.layers)
		.groupBy(Schema.layers.Level)
		.then((result) => derefEntries('level', result))

	const layersPromise = ctx
		.db()
		.select({ layer: Schema.layers.Layer })
		.from(Schema.layers)
		.groupBy(Schema.layers.Layer)
		.then((result) => derefEntries('layer', result))

	const layerVersionsPromise = ctx
		.db()
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

	fs.writeFileSync(path.join(Paths.ASSETS, 'layer-components.json'), JSON.stringify(layerComponents, null, 2))
	ctx.log.info(
		'Updated layer-components.json with %d factions, %d subfactions, %d levels, %d layers, and %d layer versions',
		layerComponents.factions.length,
		layerComponents.subfactions.length,
		layerComponents.levels.length,
		layerComponents.layers.length,
		layerComponents.layerVersions.length
	)
	if (!deepEqual(Constants.SUBFACTIONS, layerComponents.subfactions)) {
		throw new Error(
			`SUBFACTIONS should match the output of layerComponents, instead got SUBFACTIONS : ${layerComponents.subfactions.join(', ')}`
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

async function parseBiomes(_ctx: C.Log) {
	using ctx = C.pushOperation(_ctx, 'parse-biomes')
	const rawBiomes = await fsPromise.readFile(path.join(Paths.DATA, 'biomes.csv'), 'utf-8')
	const biomesRows = parse(rawBiomes, { columns: false }) as string[][]
	const biomes: Biome[] = []
	for (const row of biomesRows.slice(1).slice(0, -1)) {
		const maps = row[1].split(/\r?\n/).map((e) => e.replace('- ', ''))
		const name = row[0].replace('\n', '')
		biomes.push({
			name,
			maps,
			//@ts-expect-error nodude
			factions: BIOME_FACTIONS[name],
		})
	}
	ctx.log.info('Parsed %d biomes', biomes.length)

	return biomes
}

async function parseAlliances(_ctx: C.Log) {
	using ctx = C.pushOperation(_ctx, 'parse-alliances')
	const rawAlliances = await fsPromise.readFile(path.join(Paths.DATA, 'alliances.csv'), 'utf-8')
	const alliancesRows = parse(rawAlliances, { columns: false }) as string[][]
	let currentAlliance!: Alliance
	const alliances: Alliance[] = []
	for (const row of alliancesRows.slice(1)) {
		if (row[0]) {
			currentAlliance = {
				name: row[0],
				factions: [],
			}
			continue
		}
		const factions = row.slice(1).filter((f) => !!f)
		currentAlliance.factions.push(...factions)
		alliances.push(currentAlliance)
	}
	ctx.log.info('Parsed %d alliances', alliances.length)
	return alliances
}

function normalizeMapName(name: string) {
	return name.toLowerCase().replace(/[^a-z]/g, '')
}
function compareMapNames(a: string, b: string) {
	a = normalizeMapName(a)
	b = normalizeMapName(b)
	return a.includes(a) || b.includes(a)
}

function getSeedingMatchupsForLayer(mapName: string, alliances: Alliance[], biomes: Biome[]) {
	const biome = biomes.find((b) => b.maps.some((map) => compareMapNames(map, mapName)))!
	if (!biome) {
		throw new Error(`No biome found for map ${mapName}`)
	}
	const allBiomeFactions = alliances.flatMap((a) => a.factions).filter((f) => biome.factions.includes(f))
	const matchups: [string, string][] = []
	for (const team1 of allBiomeFactions) {
		const team1Alliance = alliances.find((a) => a.factions.includes(team1))!
		for (const team2 of allBiomeFactions) {
			const team2Alliance = alliances.find((a) => a.factions.includes(team2))!
			if (team1Alliance.name !== 'INDEPENDENT' && team1Alliance === team2Alliance) {
				continue
			}
			matchups.push([team1, team2])
		}
	}
	return matchups
}

async function generateConfigJsonSchema(_ctx: C.Log) {
	using ctx = C.pushOperation(_ctx, 'generate-config-schema')
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = zodToJsonSchema(Config.ConfigSchema.extend({ ['$schema']: z.string() }))
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	ctx.log.info('Wrote generated config schema to %s', schemaPath)
}

await main()

process.exit(0)
