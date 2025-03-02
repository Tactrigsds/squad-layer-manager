import * as SquadPipelineModels from '@/lib/squad-pipeline/squad-pipeline-models.ts'
import { parse } from 'csv-parse'
import { sql } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import * as fs from 'fs'
import * as fsPromise from 'fs/promises'
import stringifyCompact from 'json-stringify-pretty-compact'
import path from 'path'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema.ts'
import { objKeys } from '@/lib/object'
import { Biome, BIOME_FACTIONS } from '@/lib/rcon/squad-models'
import { ParsedFloatSchema, StrFlag } from '@/lib/zod'
import * as M from '@/models'
import * as Config from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { ensureEnvSetup } from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import * as Paths from '@/server/paths'
import { setupOtel } from '@/server/systems/otel'
import { zodToJsonSchema } from 'zod-to-json-schema'

export const ParsedNanFloatSchema = z
	.string()
	.regex(/^\d+(\.\d+)?$/)
	.transform((val) => parseFloat(val))
	.pipe(z.number())

const NullableFloat = ParsedFloatSchema.transform((val) => (isNaN(val) ? null : val))

const SUBFACTIONS = [
	'CombinedArms',
	'Armored',
	'LightInfantry',
	'Mechanized',
	'Motorized',
	'Support',
	'AirAssault',
	'AmphibiousAssault',
] as const

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
} as Record<(typeof SUBFACTIONS)[number], string>

const GAMEMODES = [
	'AAS',
	'RAAS',
	'TC',
	'Invasion',
	'Destruction',
	'Insurgency',
	'Skirmish',
	'Seed',
	'Track Attack',
	'Training',
	'Tanks',
] as const

const GAMEMODE_ABBREVIATIONS = {
	RAAS: 'RAAS',
	AAS: 'AAS',
	TC: 'TC',
	Invasion: 'INV',
	Skirmish: 'SK',
	Destruction: 'DES',
	Insurgency: 'INS',
	'Track Attack': 'TA',
	Seed: 'SD',
	Training: 'TR',
	Tanks: 'TN',
} satisfies Record<(typeof GAMEMODES)[number], string>

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

// layout expected from csv
export const RawLayerSchema = z
	.object({
		Level: z.string(),
		Layer: z.string(),
		Size: z.string(),
		Faction_1: z.string(),
		SubFac_1: z.enum(SUBFACTIONS).nullable(),
		Logistics_1: NullableFloat.default('nan'),
		Transportation_1: NullableFloat.default('nan'),
		'Anti-Infantry_1': NullableFloat.default('nan'),
		Armor_1: NullableFloat.default('nan'),
		ZERO_Score_1: NullableFloat.default('nan'),
		Faction_2: z.string(),
		SubFac_2: z.enum(SUBFACTIONS).nullable(),
		Logistics_2: NullableFloat.default('nan'),
		Transportation_2: NullableFloat.default('nan'),
		'Anti-Infantry_2': NullableFloat.default('nan'),
		Armor_2: NullableFloat.default('nan'),
		ZERO_Score_2: NullableFloat.default('nan'),
		Balance_Differential: NullableFloat.default('nan'),
		Asymmetry_Score: NullableFloat.default('nan'),
		Z_Pool: StrFlag.default('false'),
		Scored: StrFlag.default('false'),
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
		{ message: 'Scored layers must not have any NaNs in value columns' },
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
		{ message: 'un-scored layers must have all value columns as null' },
	)

type RawLayer = z.infer<typeof RawLayerSchema>

const Steps = z.enum(['download-pipeline', 'update-layers-table', 'update-layer-components', 'generate-config-schema'])

async function main() {
	console.log('args', process.argv)
	const args = z.array(Steps).parse(process.argv.slice(2))
	if (args.length === 0) {
		args.push(...objKeys(Steps.Values))
	}
	ensureEnvSetup()
	setupOtel()
	await ensureLoggerSetup()
	DB.setupDatabase()

	const ctx = DB.addPooledDb({ log: baseLogger, tasks: [] as Promise<any>[] })

	if (args.includes('generate-config-schema')) {
		ctx.tasks.push(generateConfigJsonSchema(ctx))
	}
	if (args.includes('download-pipeline')) await downloadPipeline(ctx)
	let pipeline: SquadPipelineModels.Output | null = null
	let factions: FactionDetails[] | null = null
	let biomes: Biome[] | null = null
	let rawLayers: RawLayer[] | null = null
	let baseLayerComponents: BaseLayerComponents | null = null
	let layerComponents: M.LayerComponents | null = null
	if (args.includes('update-layer-components')) {
		await using updateComponentsCtx = C.pushOperation(ctx, 'update-layer-components')
		;[pipeline, factions, biomes] = await Promise.all([
			pipeline ?? parsePipelineData(),
			factions ?? parseFactionDetails(ctx),
			parseBiomes(ctx),
		])
		const res = await parseRawLayersCsv(updateComponentsCtx, pipeline, biomes, factions)
		rawLayers = res.rawLayers
		baseLayerComponents = res.baseLayerComponents
		layerComponents = parseLayerComponents(updateComponentsCtx, { factionDetails: factions, baseLayerComponents, pipeline })
		updateComponentsCtx.tasks.push(
			fsPromise.writeFile(path.join(Paths.ASSETS, 'layer-components.json'), JSON.stringify(layerComponents, null, 2)),
		)
		updateComponentsCtx.log.info(
			'Updated layer-components.json with %d factions, %d subfactions, %d levels, %d layers, and %d layer versions',
			layerComponents.factions.length,
			layerComponents.subfactions.length,
			layerComponents.layers.length,
			layerComponents.layerVersions.length,
		)
	}
	if (args.includes('update-layers-table')) {
		await using updateTableCtx = C.pushOperation(ctx, 'update-layers-table')
		;[pipeline, factions, biomes] = await Promise.all([
			pipeline ?? parsePipelineData(),
			factions ?? parseFactionDetails(updateTableCtx),
			parseBiomes(updateTableCtx),
		])
		if (!rawLayers || !baseLayerComponents) {
			const res = await parseRawLayersCsv(updateTableCtx, pipeline, biomes, factions)
			baseLayerComponents = res.baseLayerComponents
			rawLayers = res.rawLayers
		}
		if (!layerComponents) {
			layerComponents = parseLayerComponents(updateTableCtx, { factionDetails: factions, baseLayerComponents, pipeline })
		}
		await updateLayersTable(updateTableCtx, pipeline, factions, biomes, rawLayers, layerComponents)
	}
	await Promise.all(ctx.tasks)
}

async function downloadPipeline(ctx: C.Log) {
	const res = await fetch(
		'https://raw.githubusercontent.com/Squad-Wiki/squad-wiki-pipeline-map-data/refs/heads/master/completed_output/_Current%20Version/finished.json',
	)
	const data = await res.json()
	await fsPromise.writeFile(path.join(Paths.DATA, 'squad-pipeline.json'), JSON.stringify(data, null, 2))
	ctx.log.info('Downloaded squad pipeline data')
}

function processLayer(rawLayer: RawLayer, layerComponents: M.LayerComponents): M.Layer {
	const { gamemode, version: version } = M.parseLayerString(rawLayer.Layer)
	const level = M.preprocessLevel(rawLayer.Level)
	const id = M.getLayerId(
		{
			Level: level,
			Gamemode: gamemode,
			LayerVersion: version,
			Faction_1: rawLayer.Faction_1,
			SubFac_1: rawLayer.SubFac_1,
			Faction_2: rawLayer.Faction_2,
			SubFac_2: rawLayer.SubFac_2,
		},
		layerComponents,
	)

	const getDiff = (key1: keyof RawLayer, key2: keyof RawLayer) => {
		const layer = rawLayer as any
		if (layer[key1] === null || layer[key2] === null) return null
		return layer[key1] - layer[key2]
	}

	const layer = {
		id,
		Gamemode: gamemode,
		LayerVersion: version,
		...rawLayer,
		Logistics_Diff: getDiff('Logistics_1', 'Logistics_2'),
		Transportation_Diff: getDiff('Transportation_1', 'Transportation_2'),
		'Anti-Infantry_Diff': getDiff('Anti-Infantry_1', 'Anti-Infantry_2'),
		Armor_Diff: getDiff('Armor_1', 'Armor_2'),
		ZERO_Score_Diff: getDiff('ZERO_Score_1', 'ZERO_Score_2'),
	} as M.Layer
	return layer
}

async function parsePipelineData() {
	return await fsPromise
		.readFile(path.join(Paths.DATA, 'squad-pipeline.json'), 'utf8')
		.then((data) => SquadPipelineModels.PipelineOutputSchema.parse(JSON.parse(data)))
}

async function parseRawLayersCsv(ctx: C.Log, pipeline: SquadPipelineModels.Output, biomes: Biome[], factions: FactionDetails[]) {
	const baseLayerComponents: BaseLayerComponents = {
		levels: new Set(),
		layers: new Set(),
		gamemodes: new Set(),
		versions: new Set(),
		factions: new Set(),
		subfactions: new Set(),
	}

	ctx.log.info('Parsing raw layers')
	const parser = await new Promise<RawLayer[]>((resolve, reject) => {
		const rawLayers: RawLayer[] = []
		fs.createReadStream(path.join(Paths.DATA, 'layers.csv'), 'utf8')
			.pipe(
				parse({
					columns: true,
					skip_empty_lines: true,
				}),
			)
			.on('data', (row) => {
				rawLayers.push(row)
			})
			.on('end', () => resolve(rawLayers))
			.on('error', reject)
	})

	const rawLayers: RawLayer[] = []

	for (const row of parser) {
		const layer = RawLayerSchema.parse(row)
		rawLayers.push(layer)
	}
	rawLayers.push(...getJensensLayers(pipeline))
	rawLayers.push(...getSeedingLayers(pipeline, biomes, factions))

	for (const layer of rawLayers) {
		const { gamemode, version } = M.parseLayerString(layer.Layer)
		baseLayerComponents.levels.add(layer.Level)
		baseLayerComponents.layers.add(layer.Layer)
		baseLayerComponents.gamemodes.add(gamemode)
		baseLayerComponents.versions.add(version)
		baseLayerComponents.factions.add(layer.Faction_1)
		baseLayerComponents.factions.add(layer.Faction_2)
		baseLayerComponents.subfactions.add(layer.SubFac_1)
		baseLayerComponents.subfactions.add(layer.SubFac_2)
	}

	ctx.log.info('Parsed %d raw layers', rawLayers.length)

	return { rawLayers, baseLayerComponents }
}

async function updateLayersTable(
	_ctx: C.Log & C.Db,
	pipeline: SquadPipelineModels.Output,
	factions: FactionDetails[],
	biomes: Biome[],
	rawLayers: RawLayer[],
	layerComponents: M.LayerComponents,
	dryRun = false,
) {
	await using ctx = C.pushOperation(_ctx, 'update-layers-table')
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
				sql`ALTER TABLE ${Schema.subfactions} ADD CONSTRAINT subfactions_factionShortName_factions_shortName_fk FOREIGN KEY (factionShortName) REFERENCES factions(shortName)`,
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
				})),
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
					.flat(),
			)

		// -------- process layers --------
		ctx.log.info('Truncating layers table')
		await ctx.db().execute(sql`TRUNCATE TABLE ${Schema.layers} `)

		// ------ disable keys for faster insert
		await ctx.db().execute(sql`SET UNIQUE_CHECKS=0`)

		const chunkSize = 2500
		let chunk: M.Layer[] = []
		const insertedIds = new Set<string>()
		for (const rawLayer of rawLayers) {
			const processed = processLayer(rawLayer, layerComponents)
			if (insertedIds.has(processed.id)) {
				ctx.log.warn('Skipping duplicate layer %s', processed.id)
				continue
			}
			chunk.push(processed)
			insertedIds.add(processed.id)
			if (chunk.length >= chunkSize) {
				if (!dryRun) {
					await ctx.db().insert(Schema.layers).values(chunk)
					rowsInserted += chunk.length
					ctx.log.info(`Inserted ${rowsInserted} rows`)
				}
				chunk = []
			}
		}

		if (chunk.length > 0) {
			await ctx.db().insert(Schema.layers).values(chunk)
			rowsInserted += chunk.length
			ctx.log.info(`Inserted ${rowsInserted} rows`)
		}
	})

	await ctx.db().execute(sql`SET UNIQUE_CHECKS=1`)
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
			.flat(),
	)
	factionFullNames.WPMC = 'Western Private Military Contractors'
	factionFullNames.PLAAGF = 'PLA Amphibious Ground Forces'
	return factionFullNames
}

function getJensensLayers(pipeline: SquadPipelineModels.Output): RawLayer[] {
	const jensensLayers: RawLayer[] = []
	for (const layerString of pipeline.mapsavailable) {
		if (!layerString.toLowerCase().includes('jensens')) continue
		const { level, jensensFactions } = M.parseLayerString(layerString)
		jensensLayers.push(
			RawLayerSchema.parse({
				Level: level,
				Layer: layerString,
				Size: 'Small',
				Faction_1: jensensFactions![0],
				SubFac_1: null,
				Faction_2: jensensFactions![1],
				SubFac_2: null,
			}),
		)
	}
	return jensensLayers
}

function getSeedingLayers(pipeline: SquadPipelineModels.Output, biomes: Biome[], factions: FactionDetails[]) {
	const seedLayers: RawLayer[] = []
	for (const layerString of pipeline.mapsavailable) {
		if (!layerString.toLowerCase().includes('seed')) continue
		const { level } = M.parseLayerString(layerString)

		const matchups = getSeedingMatchupsForLayer(level, factions, biomes)
		for (const [team1, team2] of matchups) {
			seedLayers.push(
				RawLayerSchema.parse({
					Level: level,
					Layer: layerString,
					Size: 'Small',
					Faction_1: team1,
					SubFac_1: null,
					Faction_2: team2,
					SubFac_2: null,
				}),
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

type BaseLayerComponents = {
	levels: Set<string>
	layers: Set<string>
	gamemodes: Set<string>
	versions: Set<string>
	factions: Set<string>
	subfactions: Set<string | null>
}
function parseLayerComponents(
	ctx: C.Log & C.Db & C.Op,
	{
		baseLayerComponents,
		factionDetails,
		pipeline,
	}: {
		baseLayerComponents: BaseLayerComponents
		factionDetails: FactionDetails[]
		pipeline: SquadPipelineModels.Output
	},
) {
	for (const level of baseLayerComponents.levels) {
		if (!(level in LEVEL_SHORT_NAMES)) {
			throw new Error(`level ${level} doesn't have a short name`)
		}
		if (!(level in LEVEL_ABBREVIATIONS)) {
			throw new Error(`level ${level} doesn't have an abbreviation`)
		}
	}
	for (const subfaction of baseLayerComponents.subfactions) {
		if (subfaction === null) continue
		if (!(subfaction in SUBFACTION_ABBREVIATIONS)) {
			throw new Error(`subfaction ${subfaction} doesn't have an abbreviation`)
		}
		if (!(subfaction in SUBFACTION_SHORT_NAMES)) {
			throw new Error(`subfaction ${subfaction} doesn't have a short name`)
		}
	}
	const factionFullNames = getFactionFullNames(pipeline)

	const factions = [...baseLayerComponents.factions]
	const missingFactionNames = factions.filter((faction) => !factionFullNames[faction])
	if (missingFactionNames.length > 0) {
		throw new Error(`Missing faction full names for: ${missingFactionNames.join(', ')}`)
	}
	const extraFactionNames = Object.entries(factionFullNames).filter(([faction]) => !factions.includes(faction))
	if (extraFactionNames.length > 0) {
		throw new Error(`Extra faction full names for: ${extraFactionNames.map(([f]) => f).join(', ')}`)
	}

	const subfactionFullNames = Object.fromEntries(
		factionDetails.map((faction) => {
			return [faction.faction, faction.subfactions] as const
		}),
	)

	const layerComponents: M.LayerComponents = {
		factions: factionDetails.map((f) => f.faction),
		factionFullNames: factionFullNames,
		subfactions: SUBFACTIONS as unknown as string[],
		subfactionAbbreviations: SUBFACTION_ABBREVIATIONS,
		subfactionShortNames: SUBFACTION_SHORT_NAMES,
		subfactionFullNames,
		levels: [...baseLayerComponents.levels],
		levelAbbreviations: LEVEL_ABBREVIATIONS,
		levelShortNames: LEVEL_SHORT_NAMES,
		layers: [...baseLayerComponents.layers],
		layerVersions: [...baseLayerComponents.versions],
		gamemodes: GAMEMODES as unknown as string[],
		gamemodeAbbreviations: GAMEMODE_ABBREVIATIONS,
	}

	if (!deepEqual([...SUBFACTIONS].sort(), [...layerComponents.subfactions].sort())) {
		throw new Error(
			`SUBFACTIONS should match the output of layerComponents, instead got SUBFACTIONS : ${layerComponents.subfactions.join(', ')}`,
		)
	}

	return layerComponents
}
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
			// @ts-expect-error nodude
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
		// @ts-expect-error idc
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
