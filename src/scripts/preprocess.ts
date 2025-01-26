import * as SquadPipelineModels from '@/lib/squad-pipeline/squad-pipeline-models.ts'
import { sql } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import { parse } from 'csv-parse'
import * as fsPromise from 'fs/promises'
import * as fs from 'fs'
import path from 'path'
import stringifyCompact from 'json-stringify-pretty-compact'
import { z } from 'zod'

import { zodToJsonSchema } from 'zod-to-json-schema'
import { resolvePromises } from '@/lib/async'
import * as Constants from '@/lib/constants'
import { deref as derefEntries, objKeys } from '@/lib/object'
import * as M from '@/models'
import * as Config from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { setupEnv } from '@/server/env'
import { baseLogger, setupLogger } from '@/server/logger'
import * as Schema from '@/server/schema'
import * as Paths from '@/server/paths'
import { Biome, BIOME_FACTIONS } from '@/lib/rcon/squad-models'
import { ParsedFloatSchema, StrFlag } from '@/lib/zod'

export const ParsedNanFloatSchema = z
	.string()
	.regex(/^\d+(\.\d+)?$/)
	.transform((val) => parseFloat(val))
	.pipe(z.number())

const NullableFloat = ParsedFloatSchema.transform((val) => (isNaN(val) ? null : val))

const DEFAULT_LAYER_VALUES = {
	Logistics_1: null,
	Transportation_1: null,
	'Anti-Infantry_1': null,
	Armor_1: null,
	ZERO_Score_1: null,
	Logistics_2: null,
	Transportation_2: null,
	'Anti-Infantry_2': null,
	Armor_2: null,
	ZERO_Score_2: null,
	Balance_Differential: null,
	Asymmetry_Score: null,
	Logistics_Diff: null,
	Transportation_Diff: null,
	'Anti-Infantry_Diff': null,
	Armor_Diff: null,
	ZERO_Score_Diff: null,
	Z_Pool: false,
	Scored: false,
}

// layout expected from csv
export const RawLayerSchema = z
	.object({
		Level: z.string(),
		Layer: z.string(),
		Size: z.string(),
		Faction_1: z.string(),
		SubFac_1: z.enum(Constants.SUBFACTIONS),
		Logistics_1: NullableFloat,
		Transportation_1: NullableFloat,
		'Anti-Infantry_1': NullableFloat,
		Armor_1: NullableFloat,
		ZERO_Score_1: NullableFloat,
		Faction_2: z.string(),
		SubFac_2: z.enum(Constants.SUBFACTIONS),
		Logistics_2: NullableFloat,
		Transportation_2: NullableFloat,
		'Anti-Infantry_2': NullableFloat,
		Armor_2: NullableFloat,
		ZERO_Score_2: NullableFloat,
		Balance_Differential: NullableFloat,
		Asymmetry_Score: NullableFloat,
		Z_Pool: StrFlag,
		Scored: StrFlag,
	})
	.refine(
		(layer) => {
			const scoreCols = [
				layer.Logistics_1,
				layer.Transportation_1,
				layer['Anti-Infantry_1'],
				layer.Armor_1,
				layer.ZERO_Score_1,
				layer.Logistics_2,
				layer.Transportation_2,
				layer['Anti-Infantry_2'],
				layer.Armor_2,
				layer.ZERO_Score_2,
				layer.Balance_Differential,
				layer.Asymmetry_Score,
			]
			if (layer.Scored) return scoreCols.every((n) => n !== null)
			return true
		},
		{ message: 'Scored layers must not have any NaNs in value columns' }
	)
	.refine(
		(layer) => {
			const scoreCols = [
				layer.Logistics_1,
				layer.Transportation_1,
				layer['Anti-Infantry_1'],
				layer.Armor_1,
				layer.ZERO_Score_1,
				layer.Logistics_2,
				layer.Transportation_2,
				layer['Anti-Infantry_2'],
				layer.Armor_2,
				layer.ZERO_Score_2,
				layer.Balance_Differential,
				layer.Asymmetry_Score,
			]
			if (!layer.Scored) return scoreCols.every((n) => n === null)
			return true
		},
		{ message: 'un-scored layers must have all value columns as null' }
	)

// Level,Layer,Size,Faction_1,SubFac_1,Logistics_1,Transportation_1,Anti-Infantry_1,Armor_1,ZERO_Score_1,Faction_2,SubFac_2,Logistics_2,Transportation_2,Anti-Infantry_2,Armor_2,ZERO_Score_2,Balance_Differential,Asymmetry_Score,Z_Pool,Scored

const Steps = z.enum(['download-pipeline', 'update-layers-table', 'update-layer-components', 'generate-config-schema'])

async function main() {
	const args = z.array(Steps).parse(process.argv.slice(2))
	if (args.length === 0) {
		args.push(...objKeys(Steps.Values))
	}
	setupEnv()
	await setupLogger()
	DB.setupDatabase()

	await using ctx = C.pushOperation(DB.addPooledDb({ log: baseLogger }), 'preprocess')

	if (args.includes('generate-config-schema')) {
		ctx.tasks.push(generateConfigJsonSchema(ctx))
	}
	if (args.includes('download-pipeline')) await downloadPipeline(ctx)
	let pipeline: SquadPipelineModels.Output | null = null
	let factions: FactionDetails[] | null = null
	if (args.includes('update-layers-table')) {
		let biomes: Biome[]
		;[pipeline, factions, biomes] = await Promise.all([parsePipelineData(), parseFactionDetails(ctx), parseBiomes(ctx)])
		await updateLayersTable(ctx, pipeline, factions, biomes)
	}
	if (args.includes('update-layer-components')) {
		if (!factions) factions = await parseFactionDetails(ctx)
		if (!pipeline) pipeline = await parsePipelineData()
		await updateLayerComponentsAndSubfactionFunction(ctx, factions, pipeline)
	}
	await Promise.all(ctx.tasks)
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

function processLayer(record: Record<string, string>): M.Layer {
	const res = RawLayerSchema.safeParse(record)
	if (res.error) {
		throw res.error
	}
	const rawLayer = res.data
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

	const getDiff = (key1: keyof z.infer<typeof RawLayerSchema>, key2: keyof z.infer<typeof RawLayerSchema>) => {
		const layer = rawLayer as any
		if (layer[key1] === null || layer[key2] === null) return null
		return layer[key1] - layer[key2]
	}

	return {
		id,
		Gamemode: gamemode,
		LayerVersion: version,
		...rawLayer,
		Logistics_Diff: getDiff('Logistics_1', 'Logistics_2'),
		Transportation_Diff: getDiff('Transportation_1', 'Transportation_2'),
		'Anti-Infantry_Diff': getDiff('Anti-Infantry_1', 'Anti-Infantry_2'),
		Armor_Diff: getDiff('Armor_1', 'Armor_2'),
		ZERO_Score_Diff: getDiff('ZERO_Score_1', 'ZERO_Score_2'),
	} satisfies M.Layer
}

async function parsePipelineData() {
	return await fsPromise
		.readFile(path.join(Paths.DATA, 'squad-pipeline.json'), 'utf8')
		.then((data) => SquadPipelineModels.PipelineOutputSchema.parse(JSON.parse(data)))
}

async function updateLayersTable(_ctx: C.Log & C.Db, pipeline: SquadPipelineModels.Output, factions: FactionDetails[], biomes: Biome[]) {
	await using ctx = C.pushOperation(_ctx, 'update-layers-table')
	const parser = fs.createReadStream(path.join(Paths.DATA, 'layers.csv'), 'utf8').pipe(
		parse({
			columns: true,
			skip_empty_lines: true,
		})
	)
	const t0 = performance.now()
	const factionFullNames = getFactionFullNames(pipeline)
	let rowsInserted = 0
	await DB.runTransaction(ctx, async (ctx) => {
		// process factions
		ctx.log.info('truncating factions table')
		await ctx.db().execute(sql`ALTER TABLE ${Schema.subfactions} DROP FOREIGN KEY subfactions_factionShortName_factions_shortName_fk`)
		await ctx.db().execute(sql`TRUNCATE TABLE ${Schema.subfactions}`)
		await ctx.db().execute(sql`TRUNCATE TABLE ${Schema.factions}`)
		await ctx
			.db()
			.execute(
				sql`ALTER TABLE ${Schema.subfactions} ADD CONSTRAINT subfactions_factionShortName_factions_shortName_fk FOREIGN KEY (factionShortName) REFERENCES factions(shortName)`
			)
		ctx.log.info('inserting factions')
		await ctx
			.db()
			.insert(Schema.factions)
			.values(
				factions.map((faction) => ({
					shortName: faction.faction,
					fullName: factionFullNames[faction.faction],
					alliance: faction.alliance,
				}))
			)
		await ctx
			.db()
			.insert(Schema.subfactions)
			.values(
				factions
					.map((faction) =>
						objKeys(faction.subfactions).map((subfaction) => {
							return {
								fullName: faction.subfactions[subfaction],
								shortName: subfaction,
								factionShortName: faction.faction,
							}
						})
					)
					.flat()
			)

		// process layers
		ctx.log.info('Truncating layers table')
		await ctx.db().execute(sql`TRUNCATE TABLE ${Schema.layers} `)

		await ctx.db().insert(Schema.layers).values(getJensensLayers())
		await ctx
			.db()
			.insert(Schema.layers)
			.values(getSeedingLayers(pipeline, biomes, factions))

		const chunkSize = 2500
		let chunk: M.Layer[] = []
		const insertedIds = new Set<string>()
		for await (const row of parser) {
			const processed = processLayer(row)
			if (insertedIds.has(processed.id)) {
				ctx.log.warn('Skipping duplicate layer %s', processed.id)
				continue
			}
			chunk.push(processed)
			insertedIds.add(processed.id)
			if (chunk.length >= chunkSize) {
				await ctx.db().insert(Schema.layers).values(chunk)
				rowsInserted += chunk.length
				ctx.log.info(`Inserted ${rowsInserted} rows`)
				chunk = []
			}
		}
		if (chunk.length > 0) {
			await ctx.db().insert(Schema.layers).values(chunk)
			rowsInserted += chunk.length
			ctx.log.info(`Inserted ${rowsInserted} rows`)
		}
	})

	const t1 = performance.now()
	const elapsedSecondsInsert = (t1 - t0) / 1000
	ctx.log.info(`Inserting ${rowsInserted} rows took ${elapsedSecondsInsert} s`)
}

function getFactionFullNames(pipeline: SquadPipelineModels.Output) {
	const factionFullNames = Object.fromEntries(
		Object.values(pipeline.Maps)
			.map((map) => {
				return [[map.team1.shortName, map.team1.faction] as const, [map.team2.shortName, map.team2.faction] as const]
			})
			.flat()
	)
	factionFullNames.WPMC = 'Western Private Military Contractors'
	factionFullNames.PLAAGF = 'PLA Amphibious Ground Forces'
	return factionFullNames
}

function getJensensLayers(): M.Layer[] {
	return [
		'JensensRange_WPMC-TLF',
		'JensensRange_USMC-MEA',
		'JensensRange_USA-RGF',
		'JensensRange_PLANMC-VDV',
		'JensensRange_CAF-INS',
		'JensensRange_BAF-IMF',
		'JensensRange_ADF-PLA',
	].map((layer) => {
		const { gamemode, version } = M.parseLayerString(layer)
		const [level, factions] = layer.split('_')
		const [faction1, faction2] = factions.split('-')
		const id = M.getLayerId({
			Level: level,
			Gamemode: gamemode,
			LayerVersion: version,
			Faction_1: faction1,
			SubFac_1: null,
			Faction_2: faction2,
			SubFac_2: null,
		})
		return {
			id,
			Gamemode: gamemode,
			LayerVersion: version,
			Level: level,
			Layer: layer,
			Size: 'Medium',
			Faction_1: faction1,
			SubFac_1: null,
			Faction_2: faction2,
			SubFac_2: null,
			...DEFAULT_LAYER_VALUES,
		}
	})
}

function getSeedingLayers(pipeline: SquadPipelineModels.Output, biomes: Biome[], factions: FactionDetails[]) {
	const seedLayers: M.Layer[] = []
	for (const layer of pipeline.Maps) {
		if (!layer.levelName.toLowerCase().includes('seed')) continue
		const mapName = M.preprocessLevel(layer.mapId)
		// gross
		if (layer.levelName.startsWith('Albasrah')) {
			layer.levelName = layer.levelName.replace('Albasrah', 'AlBasrah')
		}

		const matchups = getSeedingMatchupsForLayer(layer.mapName, factions, biomes)
		for (const [team1, team2] of matchups) {
			seedLayers.push(
				M.includeComputedCollections({
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
					Size: 'Small',
					Gamemode: layer.gamemode,
					LayerVersion: layer.layerVersion.toUpperCase(),
					Faction_1: team1,
					SubFac_1: null,
					Faction_2: team2,
					SubFac_2: null,
					...DEFAULT_LAYER_VALUES,
				})
			)
		}
	}
	return seedLayers
}

function normalizeMapName(name: string) {
	return name.toLowerCase().replace(/[^a-z]/g, '')
}

function compareMapNames(a: string, b: string) {
	a = normalizeMapName(a)
	b = normalizeMapName(b)
	return a.includes(a) || b.includes(a)
}

function getSeedingMatchupsForLayer(mapName: string, factions: FactionDetails[], biomes: Biome[]) {
	const biome = biomes.find((b) => b.maps.some((map) => compareMapNames(map, mapName)))!
	if (!biome) {
		throw new Error(`No biome found for map ${mapName}`)
	}
	const allBiomeFactions = factions.filter((f) => biome.factions.includes(f.faction))
	const matchups: [string, string][] = []
	for (const team1 of allBiomeFactions) {
		for (const team2 of allBiomeFactions) {
			if (team1.alliance !== 'INDEPENDENT' && team1.alliance === team2.alliance) {
				continue
			}
			matchups.push([team1.faction, team2.faction])
		}
	}
	return matchups
}

async function updateLayerComponentsAndSubfactionFunction(
	_ctx: C.Log & C.Db,
	factionDetails: FactionDetails[],
	pipeline: SquadPipelineModels.Output
) {
	await using ctx = C.pushOperation(_ctx, 'update-layer-components')
	const factionsPromise = ctx
		.db()
		.select({ faction: Schema.layers.Faction_1 })
		.from(Schema.layers)
		.groupBy(Schema.layers.Faction_1)
		.then((result) => {
			const factions = derefEntries('faction', result)
			for (const details of factionDetails) {
				if (!factions.includes(details.faction)) {
					throw new Error(`Missing faction ${details.faction} in database`)
				}
			}
			return factions
		})

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
		if (!(level in LEVEL_SHORT_NAMES)) {
			throw new Error(`level ${level} doesn't have a short name`)
		}
		if (!(level in LEVEL_ABBREVIATIONS)) {
			throw new Error(`level ${level} doesn't have an abbreviation`)
		}
	}
	for (const subfaction of await subfactionsPromise) {
		if (subfaction === null) continue
		if (!(subfaction in SUBFACTION_ABBREVIATIONS)) {
			throw new Error(`subfaction ${subfaction} doesn't have an abbreviation`)
		}
		if (!(subfaction in SUBFACTION_SHORT_NAMES)) {
			throw new Error(`subfaction ${subfaction} doesn't have a short name`)
		}
	}
	const factionFullNames = getFactionFullNames(pipeline)

	ctx.tasks.push(
		factionsPromise.then((factions) => {
			const missingFactionNames = factions.filter((faction) => !factionFullNames[faction])
			if (missingFactionNames.length > 0) {
				throw new Error(`Missing faction full names for: ${missingFactionNames.join(', ')}`)
			}
			const extraFactionNames = Object.entries(factionFullNames).filter(([faction]) => !factions.includes(faction))
			if (extraFactionNames.length > 0) {
				throw new Error(`Extra faction full names for: ${extraFactionNames.map(([f]) => f).join(', ')}`)
			}
		})
	)

	const subfactionFullNames = Object.fromEntries(
		factionDetails.map((faction) => {
			return [faction.faction, faction.subfactions] as const
		})
	)

	const layerComponents = await resolvePromises({
		factions: factionsPromise,
		factionFullNames: factionFullNames,
		subfactions: subfactionsPromise,
		subfactionAbbreviations: SUBFACTION_ABBREVIATIONS,
		subfactionShortNames: SUBFACTION_SHORT_NAMES,
		subfactionFullNames,
		levels: levelsPromise,
		levelAbbreviations: LEVEL_ABBREVIATIONS,
		levelShortNames: LEVEL_SHORT_NAMES,
		layers: layersPromise,
		layerVersions: layerVersionsPromise,
	})

	ctx.tasks.push(fsPromise.writeFile(path.join(Paths.ASSETS, 'layer-components.json'), JSON.stringify(layerComponents, null, 2)))
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

	await Promise.all(ctx.tasks)
	return layerComponents
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
	AmphibiousAssault: 'AM',
} as Record<Constants.Subfaction, string>

const LEVEL_SHORT_NAMES: Record<M.Layer['Level'], string> = {
	AlBasrah: 'Basrah',
	Anvil: 'Anvil',
	Belaya: 'Belaya',
	BlackCoast: 'Coast',
	Chora: 'Chora',
	Fallujah: 'Fallujah',
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
	AmphibiousAssault: 'Amphib',
} satisfies Record<M.Subfaction, string>

async function parseBiomes(_ctx: C.Log) {
	await using ctx = C.pushOperation(_ctx, 'parse-biomes')
	const fileStream = fs.createReadStream(path.join(Paths.DATA, 'biomes.csv'), 'utf-8')
	const parser = fileStream.pipe(parse({ columns: false }))
	const biomes: Biome[] = []
	let isFirstRow = true
	for await (const row of parser) {
		if (isFirstRow) {
			isFirstRow = false
			continue
		}
		if (!row || row.length === 0) continue
		const maps = row[1].split(/\r?\n/).map((e: string) => e.replace('- ', ''))
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

type FactionDetails = {
	faction: string
	alliance: string
	subfactions: Record<M.Subfaction, string>
}

async function parseFactionDetails(_ctx: C.Log) {
	using _ = C.pushOperation(_ctx, 'parse-faction-details')
	const filePath = path.join(Paths.DATA, 'battlegroups.csv')
	const parser = fs.createReadStream(filePath).pipe(parse({ columns: true }))
	let alliance: string | null = null
	const parsed: FactionDetails[] = []
	for await (const row of parser) {
		if (row.Alliance) alliance = row.Alliance
		if (!row.Faction) continue
		//@ts-expect-error idc
		const subfactions: Record<M.Subfaction, string> = {}
		if (row['Air Assault']) subfactions['AirAssault'] = row['Air Assault']
		if (row.Armored) subfactions['Armored'] = row.Armored
		if (row['Combined Arms']) {
			subfactions['CombinedArms'] = row['Combined Arms']
		}
		if (row['Light Infantry']) {
			subfactions['LightInfantry'] = row['Light Infantry']
		}
		if (row.Mechanized) subfactions['Mechanized'] = row.Mechanized
		if (row.Motorized) subfactions['Motorized'] = row.Motorized
		if (row.Support) subfactions['Support'] = row.Support

		parsed.push({
			faction: row.Faction,
			alliance: alliance!,
			subfactions,
		})
	}
	return parsed
}

async function generateConfigJsonSchema(_ctx: C.Log) {
	await using ctx = C.pushOperation(_ctx, 'generate-config-schema')
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = zodToJsonSchema(Config.ConfigSchema.extend({ ['$schema']: z.string() }))
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	ctx.log.info('Wrote generated config schema to %s', schemaPath)
}

await main()

process.exit(0)
