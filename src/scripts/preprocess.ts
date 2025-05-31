import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import * as LC from '@/layer-components.models'
import * as ObjUtils from '@/lib/object'
import * as OneToMany from '@/lib/one-to-many-map'
import { OneToManyMap } from '@/lib/one-to-many-map'
import { isNullOrUndef } from '@/lib/typeGuards'
import { ParsedFloatSchema, StrFlag } from '@/lib/zod'
import * as M from '@/models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import * as Paths from '@/server/paths'
import { parse } from 'csv-parse'
import { sql } from 'drizzle-orm'
import http from 'follow-redirects'
import * as fs from 'fs'
import * as fsPromise from 'fs/promises'
import path from 'path'
import { z } from 'zod'

export const ParsedNanFloatSchema = z
	.string()
	.regex(/^\d+(\.\d+)?$/)
	.transform((val) => parseFloat(val))
	.pipe(z.number())

const NullableFloat = ParsedFloatSchema.transform((val) => (isNaN(val) ? null : val))

const LayerScores = {
	Logistics_1: NullableFloat.default('nan'),
	Transportation_1: NullableFloat.default('nan'),
	'Anti-Infantry_1': NullableFloat.default('nan'),
	Armor_1: NullableFloat.default('nan'),
	ZERO_Score_1: NullableFloat.default('nan'),
	Logistics_2: NullableFloat.default('nan'),
	Transportation_2: NullableFloat.default('nan'),
	'Anti-Infantry_2': NullableFloat.default('nan'),
	Armor_2: NullableFloat.default('nan'),
	ZERO_Score_2: NullableFloat.default('nan'),
	Balance_Differential: NullableFloat.default('nan'),
	Asymmetry_Score: NullableFloat.default('nan'),
	Z_Pool: StrFlag.default('false'),
	Scored: StrFlag.default('false'),
}

// layout expected from csv
export const ScoredLayerSchema = z
	.object({
		Layer: z.string(),
		Size: z.string(),
		Faction_1: z.string(),
		Unit_1: z.string(),
		Faction_2: z.string(),
		Unit_2: z.string(),
		...LayerScores,
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

const Steps = z.enum(['update-layers-table', 'download-csvs'])

const envBuilder = Env.getEnvBuilder({ ...Env.groups.sheets })
let ENV!: ReturnType<typeof envBuilder>

async function main() {
	const args = z.array(Steps).parse(process.argv.slice(2))
	if (args.length === 0) {
		args.push(...ObjUtils.objKeys(Steps.Values))
	}
	Env.ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()
	await DB.setupDatabase()

	const ctx = DB.addPooledDb({ log: baseLogger, tasks: [] as Promise<any>[] })

	await ensureAllSheetsDownloaded()

	const data = await parseSquadLayerSheetData(ctx)
	const components = LC.toLayerComponentsJson(LC.buildFullLayerComponents(data.components))
	const fullLayers = await parseLayerScores(ctx, data, components)

	await fsPromise.writeFile(path.join(Paths.ASSETS, 'layer-components.json'), JSON.stringify(components, null, 2))

	if (args.includes('update-layers-table')) {
		await updateLayersTable(ctx, fullLayers)
	}
}

async function parseLayerScores(ctx: C.Log, data: SheetData, components: LC.LayerComponentsJson) {
	return await new Promise<SchemaModels.NewLayer[]>((resolve, reject) => {
		const fullLayers: SchemaModels.NewLayer[] = data.baseLayers.map((layer): SchemaModels.NewLayer => ({
			...layer,
		}))
		const seenIds = new Set<string>()
		fs.createReadStream(path.join(Paths.DATA, 'layers.csv'), 'utf8')
			.pipe(
				parse({
					columns: true,
					skip_empty_lines: true,
				}),
			)
			.on('data', (_row) => {
				const row = ScoredLayerSchema.parse(_row)
				if (!row.Scored) return
				if (!data.components.mapLayers.find(l => l.Layer === row['Layer'])) {
					throw new Error(`Layer ${row['Layer']} not found`)
				}
				if (!data.components.factions.has(row.Faction_1)) {
					throw new Error(`Faction_1 ${row['Faction_1']} :  not found`)
				}
				if (!data.components.factions.has(row.Faction_2)) {
					throw new Error(`Faction_2 ${row['Faction_2']} :  not found`)
				}
				if (!data.components.units.has(row.Unit_1)) {
					throw new Error(`Unit_1 ${row['Unit_1']} not found`)
				}
				if (!data.components.units.has(row.Unit_2)) {
					throw new Error(`Unit_2 ${row['Unit_2']} not found`)
				}

				const segments = M.parseLayerStringSegment(row['Layer'])
				if (!segments) throw new Error(`Layer ${row['Layer']} is invalid`)
				const diffs: Record<string, number> = {}
				for (const [key, value] of Object.entries(row)) {
					if (!value) continue
					if (!Object.keys(LayerScores).includes(key)) continue
					if (!key.match(/.+1$/)) continue
					if (typeof value !== 'number') throw new Error(`Value ${value} is not a number in col ${key}`)
					// @ts-expect-error idgaf
					const otherTeamValue = row[key.replace(/1$/, '2')]
					const diffKey = key.replace(/1$/, 'Diff')
					diffs[diffKey] = value - otherTeamValue
				}

				if (!segments) throw new Error(`Layer ${row['Layer']} is invalid`)
				const idArgs = {
					Map: segments.Map,
					Gamemode: segments.Gamemode,
					LayerVersion: segments.LayerVersion,
					Faction_1: row['Faction_1'],
					Faction_2: row['Faction_2'],
					Unit_1: row['Unit_1'],
					Unit_2: row['Unit_2'],
				}
				const layerId = M.getLayerId(idArgs, components)
				if (seenIds.has(layerId)) {
					ctx.log.warn(`Duplicate layer id ${layerId} found: ${JSON.stringify(idArgs)}`)
					return
				}
				seenIds.add(layerId)

				const index = data.idToIdx.get(layerId)
				// availability sheet is out of date but based zero has a workaround that I don't want to bother to implement :shrug:
				if (segments.Map === 'Sanxian' && isNullOrUndef(index)) {
					fullLayers.push({
						...row,
						id: layerId,
						LayerVersion: segments.LayerVersion,
						Size: row.Size,
						Map: segments.Map,
						Gamemode: segments.Gamemode,
						Alliance_1: data.components.factionToAlliance.get(row['Faction_1'])!,
						Alliance_2: data.components.factionToAlliance.get(row['Faction_2'])!,
						...diffs,
					})
					return
				} else if (isNullOrUndef(index)) {
					ctx.log.warn(`Layer id ${layerId} not found: ${JSON.stringify(idArgs)}`)
					return
				}
				fullLayers[index] = { ...fullLayers[index], ...row, ...diffs }
			})
			.on('end', () => resolve(fullLayers))
			.on('error', reject)
	})
}

async function updateLayersTable(
	ctx: C.Log & C.Db,
	finalLayers: SchemaModels.NewLayer[],
) {
	const t0 = performance.now()
	let rowsInserted = 0

	await DB.runTransaction(ctx, async (ctx) => {
		// -------- process layers --------
		ctx.log.info('Truncating layers table')
		await ctx.db().execute(sql`TRUNCATE TABLE ${Schema.layers} `)

		// ------ disable keys for faster insert
		await ctx.db().execute(sql`SET UNIQUE_CHECKS=0`)

		const insertedIds = new Set<string>()
		const chunkSize = 2500
		let chunk: SchemaModels.NewLayer[] = []
		for (const layer of finalLayers) {
			if (insertedIds.has(layer.id)) continue
			chunk.push(layer)
			if (chunk.length >= chunkSize) {
				await C.setLogLevel(ctx, 'warn').db({ redactParams: true }).insert(Schema.layers).values(chunk)
				rowsInserted += chunk.length
				ctx.log.info(`Inserted ${rowsInserted} rows`)
				chunk = []
			}
		}

		if (chunk.length > 0) {
			await C.setLogLevel(ctx, 'warn').db({ redactParams: true }).insert(Schema.layers).values(chunk)
			rowsInserted += chunk.length
			ctx.log.info(`Inserted ${rowsInserted} rows`)
		}
	})
	const t1 = performance.now()
	const elapsedSecondsInsert = (t1 - t0) / 1000
	ctx.log.info(`Inserting ${rowsInserted} rows took ${elapsedSecondsInsert} s`)
}

type FactionUnit = `${string}:${string}`
type BattlegroupsData = {
	allianceToFaction: OneToManyMap<string, string>
	factionToUnit: OneToManyMap<string, string>
	factionUnitToUnitFullName: Map<FactionUnit, string>
}

type BaseLayer = {
	id: string
	Map: string
	Layer: string
	Size: string
	Gamemode: string
	LayerVersion: string | null
	Faction_1: string
	Unit_1: string
	Faction_2: string
	Unit_2: string
	Alliance_1: string
	Alliance_2: string
}

type SheetData = Awaited<ReturnType<typeof parseSquadLayerSheetData>>
async function parseSquadLayerSheetData(ctx: C.Log) {
	const mapLayers = await parseMapLayers()
	const { allianceToFaction, factionToUnit, factionUnitToUnitFullName } = await parseBattlegroups(ctx)

	const { availability } = await parseBgLayerAvailability(ctx)
	const factionToAlliance = OneToMany.invertOneToOne(allianceToFaction)

	const baseLayers: BaseLayer[] = []
	const idToIdx: Map<string, number> = new Map()
	const components: LC.LayerComponents = LC.buildFullLayerComponents({
		mapLayers,
		allianceToFaction,
		factionToAlliance,
		factionToUnit,
		factionUnitToUnitFullName,
		layerFactionAvailability: availability,

		gamemodes: new Set(),
		alliances: new Set(),
		maps: new Set(),
		layers: new Set(),
		versions: new Set(),
		factions: new Set(),
		units: new Set(),
		size: new Set(),
	}, true)

	// Validate that all layers in availability are in mapLayers
	const layerNames = new Set(mapLayers.map(l => l.Layer))
	for (const availEntry of availability) {
		if (!layerNames.has(availEntry.Layer)) {
			throw new Error(`Layer ${availEntry.Layer} from availability not found in mapLayers`)
		}
	}

	for (const layer of mapLayers) {
		components.maps.add(layer.Map)
		components.size.add(layer.Size)
		components.layers.add(layer.Layer)
		for (const availEntry1 of availability) {
			if (availEntry1.Layer !== layer.Layer) continue
			if (!availEntry1.allowedTeams.includes(1)) continue
			for (const availEntry2 of availability) {
				if (!availEntry2.allowedTeams.includes(2)) continue
				if (availEntry2.Layer !== layer.Layer) continue

				const alliance1 = factionToAlliance.get(availEntry1.Faction)!
				const alliance2 = factionToAlliance.get(availEntry2.Faction)!
				if (availEntry1.Faction === availEntry2.Faction) continue
				if (alliance1 === alliance2 && alliance1 !== 'INDEPENDENT') continue

				const parsedSegments = M.parseLayerStringSegment(layer.Layer)
				if (!parsedSegments) throw new Error(`Invalid layer string segment: ${layer.Layer}`)
				components.alliances.add(factionToAlliance.get(availEntry1.Faction)!)
				components.alliances.add(factionToAlliance.get(availEntry2.Faction)!)
				if (parsedSegments.LayerVersion) components.versions.add(parsedSegments.LayerVersion)
				components.gamemodes.add(parsedSegments.Gamemode)
				components.factions.add(availEntry1.Faction)
				components.factions.add(availEntry2.Faction)
				if (availEntry1.Unit) components.units.add(availEntry1.Unit)
				if (availEntry2.Unit) components.units.add(availEntry2.Unit)
				if (!parsedSegments) throw new Error(`Invalid layer string segment: ${layer.Layer}`)
				const layerId = M.getLayerId({
					Map: layer.Map,
					LayerVersion: parsedSegments.LayerVersion,
					Gamemode: parsedSegments?.Gamemode,
					Faction_1: availEntry1.Faction,
					Faction_2: availEntry2.Faction,
					Unit_1: availEntry1.Unit ?? null,
					Unit_2: availEntry2.Unit ?? null,
				}, LC.toLayerComponentsJson(components))
				const baseLayer = {
					id: layerId,
					Map: layer.Map,
					Layer: layer.Layer,
					Gamemode: parsedSegments.Gamemode,
					LayerVersion: parsedSegments.LayerVersion,
					Size: layer.Size,
					Faction_1: availEntry1.Faction,
					Unit_1: availEntry1.Unit ?? null,
					Faction_2: availEntry2.Faction,
					Unit_2: availEntry2.Unit ?? null,
					Alliance_1: factionToAlliance.get(availEntry1.Faction)!,
					Alliance_2: factionToAlliance.get(availEntry2.Faction)!,
				}
				idToIdx.set(layerId, baseLayers.length)
				baseLayers.push(baseLayer)
			}
		}
	}

	ctx.log.info('Parsed %s total layers', baseLayers.length)
	return { baseLayers, idToIdx, components, availability }
}

function parseBattlegroups(ctx: C.Log) {
	return new Promise<BattlegroupsData>((resolve, reject) => {
		const allianceToFaction: OneToManyMap<string, string> = new Map()
		const factionToUnit: OneToManyMap<string, string> = new Map()
		const factionUnitToFullUnitName: Map<`${string}:${string}`, string> = new Map()

		let currentAlliance: string | undefined
		fs.createReadStream(path.join(Paths.DATA, 'battlegroups.csv'))
			.pipe(parse({ columns: true }))
			.on('data', (row) => {
				if (row.Alliance) currentAlliance = row.Alliance
				if (!row.Faction) return
				const faction = row.Faction === 'MEI' ? 'INS' : row.Faction

				OneToMany.set(allianceToFaction, currentAlliance, faction)
				for (const [key, value] of Object.entries(row)) {
					if (key === 'Alliance' || key === 'Faction' || !key || !value) continue
					OneToMany.set(factionToUnit, faction, key.replace(' ', ''))
					factionUnitToFullUnitName.set(`${faction}:${key.replace(' ', '')}`, value as string)
				}
			})
			.on('end', () => {
				ctx.log.info(`Parsed ${allianceToFaction.size} alliance to faction mappings`)
				ctx.log.info(`Parsed ${factionToUnit.size} faction to unit mappings`)
				ctx.log.info(`Parsed ${factionUnitToFullUnitName.size} faction unit to full unit name mappings`)

				resolve({ allianceToFaction, factionToUnit, factionUnitToUnitFullName: factionUnitToFullUnitName })
			})
			.on('error', (error) => {
				ctx.log.error('Error parsing battlegroups CSV:', error)
				reject(error)
			})
	})
}

function parseMapLayers() {
	return new Promise<M.MapConfigLayer[]>((resolve, reject) => {
		const layers: M.MapConfigLayer[] = []
		let currentMap: string | undefined
		fs.createReadStream(path.join(Paths.DATA, 'map-layers.csv'))
			.pipe(parse({ columns: true }))
			.on('data', (row: Record<string, string>) => {
				if (!row['Layer Name']) return
				if (row['Level']) currentMap = M.preprocessLevel(row['Level'])
				const layer = { Map: M.preprocessLevel(currentMap!), Layer: row['Layer Name'], Size: row['Layer Size*'] }
				const segments = M.parseLayerStringSegment(layer.Layer)
				if (!segments) throw new Error(`Invalid layer string: ${layer.Layer}`)
				const withSegments = {
					...layer,
					Gamemode: segments.Gamemode!,
					LayerVersion: segments.LayerVersion!,
				}
				layers.push(withSegments)
				if (withSegments.Gamemode === 'RAAS') {
					layers.push({ ...withSegments, Gamemode: 'FRAAS', Layer: withSegments.Layer.replace('RAAS', 'FRAAS') })
				}
			})
			.on('end', () => {
				resolve(layers)
			})
			.on('error', (error) => {
				console.error('Error parsing map layers CSV:', error)
				reject(error)
			})
		return layers
	})
}

type LayerFactionAvailabilityEntry = {
	Layer: string
	Faction: string
	Unit: string
	allowedTeams: (1 | 2)[]
	isDefaultUnit: boolean
}
function parseBgLayerAvailability(ctx: C.Log) {
	return new Promise<{ availability: LayerFactionAvailabilityEntry[] }>((resolve, reject) => {
		const entries: LayerFactionAvailabilityEntry[] = []
		const col = {
			Layer: 2,
			Faction: 3,
			Unit: 4,
			UnitFullName: 5,
			TeamOptions: 6,
			sheetLink: 8,
		}

		let currentLayer: string | undefined
		let currentFaction: string | undefined
		let i = 0
		fs.createReadStream(path.join(Paths.DATA, 'bg-layer-availability.csv'))
			.pipe(parse({ columns: false }))
			.on('data', (row: string[]) => {
				if (i < 5) {
					i++
					return
				}

				if (row[col.Layer]) {
					currentLayer = row[col.Layer]
					return
				}
				let unit: string | undefined
				let isDefaultUnit = false
				if (currentLayer?.startsWith('JensensRange')) {
					currentFaction = row[col.UnitFullName]?.split(' ')?.[0]
					unit = 'CombinedArms'
				} else if (row[col.Faction]) {
					currentFaction = row[col.Faction]

					const url = new URL(row[col.sheetLink])
					const gid = parseInt(url.hash.replace('#gid=', '').replace(/\?range.+$/, ''))
					unit = SHEETS.find(sheet => sheet.gid === gid)!.unit
					if (!unit) throw new Error(`Unit ${row[col.UnitFullName]} not found for faction ${row[col.Faction]}`)
					isDefaultUnit = true
				} else if (row[col.Unit]) {
					unit = row[col.Unit]
				} else {
					return
				}
				const teams: (1 | 2)[] = []
				if (row[col.TeamOptions].includes('1')) teams.push(1)
				if (row[col.TeamOptions].includes('2')) teams.push(2)
				const entry = { Layer: currentLayer!, Faction: currentFaction!, Unit: unit, allowedTeams: teams, isDefaultUnit }
				entries.push(entry)
				const segments = M.parseLayerStringSegment(currentLayer!)
				if (!segments) throw new Error(`Invalid layer string segment: ${currentLayer}`)
				if (segments.Gamemode === 'RAAS') {
					entries.push({
						...entry,
						Layer: entry.Layer.replace('RAAS', 'FRAAS'),
					})
				}
			})
			.on('end', () => {
				ctx.log.info(`Parsed ${entries.length} layer availability entries`)
				resolve({ availability: entries })
			})
			.on('error', (error) => {
				ctx.log.error('Error parsing battlegroups CSV:', error)
				reject(error)
			})
	})
}

async function ensureAllSheetsDownloaded(opts?: { invalidate?: boolean }) {
	const invalidate = opts?.invalidate ?? false
	const ops: Promise<void>[] = []
	for (const sheet of SHEETS) {
		const sheetPath = path.join(Paths.DATA, sheet.filename)
		if (invalidate || !fs.existsSync(sheetPath)) {
			ops.push(downloadPublicSheetAsCSV(sheet.gid, sheetPath))
		}
	}
	await Promise.all(ops)
}

function downloadPublicSheetAsCSV(gid: number, filepath: string) {
	const url = `https://docs.google.com/spreadsheets/d/${ENV.SPREADHSEET_ID}/export?gid=${gid}&format=csv#gid=${gid}`

	return new Promise<void>((resolve, reject) => {
		const file = fs.createWriteStream(filepath)

		http.https.get(url, (response) => {
			response.pipe(file)

			file.on('finish', () => {
				file.close()
				console.log(`CSV downloaded successfully to ${filepath}!`)
				resolve()
			})

			file.on('error', (error) => {
				file.close()
				console.error(`Error downloading CSV from ${url} to ${filepath}:`, error)
				reject(error)
			})
		}).on('error', (error) => {
			console.error('Error:', error)
			reject(error)
		})
	})
}

const SHEETS = [
	{
		name: 'battlegroups',
		filename: 'battlegroups.csv',
		gid: 1796438364,
	},
	{
		name: 'alliances',
		filename: 'alliances.csv',
		gid: 337815939,
	},
	{
		name: 'biomes',
		filename: 'biomes.csv',
		gid: 1025614852,
	},
	{
		name: 'bgDescriptions',
		filename: 'bg-descriptions.csv',
		gid: 104824254,
	},
	{
		name: 'bgLayerAvailability',
		filename: 'bg-layer-availability.csv',
		gid: 1881530590,
	},
	{
		name: 'mapLayers',
		filename: 'map-layers.csv',
		gid: 1212962563,
	},
	{
		name: 'Assets:AirAssault:Large:Offense',
		filename: 'assets-airassault-large-offense.csv',
		unit: 'Amphibious',
		gid: 196602319,
	},
	{
		name: 'Assets:AmphibiousAssault:Large:Offense',
		filename: 'assets-amphibious-large-offense.csv',
		unit: 'AmphibiousAssault',
		gid: 1592545787,
	},
	{
		name: 'Assets:CombinedArms:Large:Offense',
		filename: 'assets-combinedarms-large-offense.csv',
		unit: 'CombinedArms',
		gid: 55130916,
	},
	{
		name: 'Assets:CombinedArms:Large:Defense',
		filename: 'assets-combinedarms-large-defense.csv',
		unit: 'CombinedArms',
		gid: 1024747126,
	},
	{
		name: 'Assets:LightInfantry:Large:Offense',
		filename: 'assets-lightinfantry-large-offense.csv',
		unit: 'LightInfantry',
		gid: 706333626,
	},
	{
		name: 'Assets:LightInfantry:Large:Defense',
		filename: 'assets-lightinfantry-large-defense.csv',
		unit: 'LightInfantry',
		gid: 1650555364,
	},
	{
		name: 'Assets:Mechanized:Large:Offense',
		filename: 'assets-mechanized-large-offense.csv',
		unit: 'Mechanized',
		gid: 996007242,
	},
	{
		name: 'Assets:Mechanized:Large:Defense',
		filename: 'assets-mechanized-large-defense.csv',
		unit: 'Mechanized',
		gid: 1128826127,
	},
	{
		name: 'Assets:Motorized:Large:Offense',
		filename: 'assets-motorized-large-offense.csv',
		unit: 'Motorized',
		gid: 131120776,
	},
	{
		name: 'Assets:Motorized:Large:Defense',
		filename: 'assets-motorized-large-defense.csv',
		unit: 'Motorized',
		gid: 1681257950,
	},
	{
		name: 'Assets:Support:Large:Offense',
		filename: 'assets-support-large-offense.csv',
		unit: 'Support',
		gid: 2080033084,
	},
	{
		name: 'Assets:Support:Large:Defense',
		filename: 'assets-support-large-defense.csv',
		unit: 'Support',
		gid: 1622797716,
	},
	{
		name: 'Assets:CombinedArms:Medium:Offense',
		filename: 'assets-combinedarms-medium-offense.csv',
		unit: 'CombinedArms',
		gid: 970369378,
	},
	{
		name: 'Assets:CombinedArms:Medium:Defense',
		filename: 'assets-combinedarms-medium-defense.csv',
		unit: 'CombinedArms',
		gid: 188928736,
	},
	{
		name: 'Assets:CombinedArms:Small',
		filename: 'assets-combinedarms-small.csv',
		unit: 'CombinedArms',
		gid: 2069827913,
	},
	{
		name: 'Assets:CombinedArms:Seed',
		filename: 'assets-combinedarms-seed.csv',
		unit: 'CombinedArms',
		gid: 1905776366,
	},
]

await main()

process.exit(0)
