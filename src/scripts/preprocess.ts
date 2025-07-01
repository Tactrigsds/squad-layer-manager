import * as ObjUtils from '@/lib/object'
import * as OneToMany from '@/lib/one-to-many-map'
import { OneToManyMap } from '@/lib/one-to-many-map'
import { isNullOrUndef } from '@/lib/type-guards'
import { ParsedFloatSchema, ParsedIntSchema, StrFlag } from '@/lib/zod'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import * as Paths from '@/server/paths'
import * as LayerDb from '@/server/systems/layer-db.server'
import { parse } from 'csv-parse'
import { sql } from 'drizzle-orm'
import http from 'follow-redirects'
import * as fs from 'fs'
import * as fsPromise from 'fs/promises'
import childProcess from 'node:child_process'
import path from 'path'
import * as Rx from 'rxjs'
import { z } from 'zod'

export const ParsedNanFloatSchema = z
	.string()
	.regex(/^\d+(\.\d+)?$/)
	.transform((val) => parseFloat(val))
	.pipe(z.number())

const ParsedNullableFloat = ParsedFloatSchema.transform((val) => (isNaN(val) ? null : val))

const Steps = z.enum(['update-layers-table', 'download-csvs'])

const envBuilder = Env.getEnvBuilder({ ...Env.groups.sheets, ...Env.groups.db })
let ENV!: ReturnType<typeof envBuilder>

async function main() {
	const args = z.array(Steps).parse(process.argv.slice(2))
	if (args.length === 0) {
		args.push(...ObjUtils.objKeys(Steps.Values))
	}
	Env.ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()
	await LayerDb.setup({ skipHash: true, mode: 'populate' })
	await DB.setupDatabase()

	const ctx = { log: baseLogger, layerDb: () => LayerDb.db, effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.EXTRA_COLS_CONFIG) }

	await ensureAllSheetsDownloaded()

	const data = await parseSquadLayerSheetData(ctx)
	const components = LC.toLayerComponentsJson(LC.buildFullLayerComponents(data.components))

	await fsPromise.writeFile(path.join(Paths.ASSETS, 'layer-components.json'), JSON.stringify(components, null, 2))

	ctx.log.info('executing drizzle-kit push')
	childProcess.spawnSync('pnpm', ['drizzle-kit', 'push', '--config', 'drizzle-layersdb.config.ts'])

	if (args.includes('update-layers-table')) {
		const scoresExtracted = extractLayerScores(ctx, components)
		await populateLayersTable(ctx, components, Rx.from(data.baseLayers))
		await scoresExtracted
		ctx.layerDb().run('PRAGMA wal_checkpoint')
		ctx.layerDb().run('VACUUM')
		ctx.layerDb().$client.close()
	}
}

function extractLayerScores(ctx: CS.Log & CS.Layers, components: LC.LayerComponentsJson): Promise<void> {
	const extraColsZodProps: Record<string, z.ZodType> = {}
	for (const col of LayerDb.EXTRA_COLS_CONFIG.columns) {
		let schema: z.ZodType
		switch (col.type) {
			case 'string':
				schema = z.string().optional()
				break
			case 'integer':
				schema = ParsedIntSchema
				break
			case 'boolean':
				schema = StrFlag.transform(v => Number(v))
				break
			case 'float':
				schema = ParsedNullableFloat
				break
			default:
				throw new Error(`Unsupported column type: ${(col as any).type}`)
		}
		extraColsZodProps[col.name] = schema
	}
	const extraColsZodSchema = z.object(extraColsZodProps)
	const extraLayerColsSubject = new Rx.Subject<any>()

	const seenIds = new Set<string>()
	fs.createReadStream(path.join(Paths.DATA, 'layers.csv'), 'utf8')
		.pipe(
			parse({
				columns: true,
				skip_empty_lines: true,
			}),
		)
		.on('data', (row) => {
			if (row.Scored === 'False') return

			const segments = L.parseLayerStringSegment(row['Layer'])
			if (!segments) throw new Error(`Layer ${row['Layer']} is invalid`)

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
			const ids = [L.getKnownLayerId(idArgs, components)!]
			// for now we're just using the same data for FRAAS as RAAS
			if (segments.Gamemode === 'RAAS') {
				ids.push(L.getKnownLayerId({ ...idArgs, Gamemode: 'FRAAS' }, components)!)
			}
			const extraColsRow = extraColsZodSchema.parse(row)
			for (const layerId of ids) {
				if (seenIds.has(layerId)) {
					ctx.log.warn(`Duplicate extra layer ${layerId} found`)
					continue
				}
				seenIds.add(layerId)

				extraLayerColsSubject.next({ ...extraColsRow, id: layerId })
			}
		})
		.on('end', () => {
			extraLayerColsSubject.complete()
		})
		.on('error', () => {
			extraLayerColsSubject.complete()
		})

	ctx.layerDb().run(sql`DELETE FROM ${LC.extraColsSchema(ctx)} `)
	let chunkCount = 1
	extraLayerColsSubject.pipe(
		Rx.bufferCount(500),
		Rx.concatMap(async (buf) => {
			for (const layer of buf) {
				seenIds.add(layer.id)
			}
			for (const layer of buf) {
				for (const [key, value] of Object.entries(layer)) {
					if (
						value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint' && !Buffer.isBuffer(value)
					) {
						ctx.log.error(`Invalid value type for key "${key}":`, typeof value, value)
						throw new Error(`Invalid SQLite value type for key "${key}": ${typeof value} (${JSON.stringify(value)})`)
					}
				}
			}
			await ctx.layerDb().insert(LC.extraColsSchema(ctx)).values(buf.map(layer => ({ ...layer, id: LC.packLayer(layer.id) })))
			ctx.log.info(`Inserted %s extraLayers`, buf.length * chunkCount)
			chunkCount++
		}),
		Rx.tap({
			complete: () => {
				ctx.log.info('extraLayers insert completed')
			},
		}),
	).subscribe()

	return new Promise(resolve => {
		extraLayerColsSubject.subscribe({
			complete: () => {
				resolve()
			},
		})
	})
}

async function populateLayersTable(
	ctx: CS.Log & CS.Layers,
	components: LC.LayerComponentsJson,
	finalLayers: Rx.Observable<L.KnownLayer>,
) {
	const t0 = performance.now()

	// -------- process layers --------
	ctx.log.info('Truncating layers table')
	ctx.layerDb().run(sql`DELETE FROM ${LC.layers} `)
	ctx.layerDb().run(sql`DELETE FROM ${LC.layerStrIds} `)
	let chunkCount = 1
	const seenIds: Set<string> = new Set()
	await Rx.lastValueFrom(finalLayers.pipe(
		Rx.bufferCount(500),
		Rx.concatMap(async (buf) => {
			ctx.log.info(`Inserting %s rows`, buf.length * chunkCount)
			for (const layer of buf) {
				if (seenIds.has(layer.id)) {
					throw new Error(`Duplicate layer ID: ${layer.id}`)
				}
				seenIds.add(layer.id)
			}
			await ctx.layerDb().insert(LC.layerStrIds).values(buf.map(layer => ({ id: LC.packLayer(layer), idStr: layer.id })))
			await ctx.layerDb().insert(LC.layers).values(buf.map(layer => LC.toRow(layer, components)))
			chunkCount++
		}),
	))

	const t1 = performance.now()
	const elapsedSecondsInsert = (t1 - t0) / 1000
	ctx.log.info(`Inserting ${chunkCount * 500} rows took ${elapsedSecondsInsert} s`)
}

type FactionUnit = `${string}:${string}`
type BattlegroupsData = {
	allianceToFaction: OneToManyMap<string, string>
	factionToUnit: OneToManyMap<string, string>
	factionUnitToUnitFullName: Map<FactionUnit, string>
}

type BaseLayer = L.KnownLayer

type SheetData = Awaited<ReturnType<typeof parseSquadLayerSheetData>>
async function parseSquadLayerSheetData(ctx: CS.Log) {
	const availPromise = parseBgLayerAvailability(ctx)
	const mapLayers = await parseMapLayers()
	const { allianceToFaction, factionToUnit, factionUnitToUnitFullName } = await parseBattlegroups(ctx)

	const { availability } = await availPromise
	const factionToAlliance = OneToMany.invertOneToOne(allianceToFaction)

	const baseLayers: BaseLayer[] = []
	const idToIdx: Map<string, number> = new Map()
	const components: LC.LayerComponents = LC.buildFullLayerComponents(
		{
			mapLayers,
			allianceToFaction,
			factionToAlliance,
			factionToUnit,
			factionUnitToUnitFullName,
			layerFactionAvailability: availability,

			gamemodes: new Set([]),
			alliances: new Set(),
			maps: new Set(),
			layers: new Set(),
			versions: new Set(),
			factions: new Set(),
			units: new Set(),
			size: new Set(),
		},
		true,
	)

	// Validate that all layers in availability are in mapLayers
	const layerNames = new Set(mapLayers.map(l => l.Layer))
	for (const layer of availability.keys()) {
		if (!layerNames.has(layer)) {
			throw new Error(`Layer ${layer} from availability not found in mapLayers`)
		}
	}

	for (const layer of mapLayers) {
		components.maps.add(layer.Map)
		components.size.add(layer.Size)
		components.layers.add(layer.Layer)
		for (const availEntry1 of availability.get(layer.Layer)!) {
			if (!availEntry1.allowedTeams.includes(1)) continue
			for (const availEntry2 of availability.get(layer.Layer)!) {
				if (!availEntry2.allowedTeams.includes(2)) continue

				const alliance1 = factionToAlliance.get(availEntry1.Faction)!
				const alliance2 = factionToAlliance.get(availEntry2.Faction)!
				if (availEntry1.Faction === availEntry2.Faction) continue
				if (alliance1 === alliance2 && alliance1 !== 'INDEPENDENT') continue

				const parsedSegments = L.parseLayerStringSegment(layer.Layer)
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
				const layerId = L.getKnownLayerId({
					Map: layer.Map,
					LayerVersion: parsedSegments.LayerVersion,
					Gamemode: parsedSegments.Gamemode,
					Faction_1: availEntry1.Faction,
					Faction_2: availEntry2.Faction,
					Unit_1: availEntry1.Unit ?? null,
					Unit_2: availEntry2.Unit ?? null,
				}, LC.toLayerComponentsJson(components))!
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

function parseBattlegroups(ctx: CS.Log) {
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

function preprocessLevel(level: string) {
	level = level.replace(/\s/g, '')
	if (level.startsWith('Sanxian')) return 'Sanxian'
	if (level.startsWith('Belaya')) return 'Belaya'
	if (level.startsWith('Albasrah')) return level.replace('Albasrah', 'AlBasrah')
	return level
}

function parseMapLayers() {
	return new Promise<LC.MapConfigLayer[]>((resolve, reject) => {
		const layers: LC.MapConfigLayer[] = []
		let currentMap: string | undefined
		fs.createReadStream(path.join(Paths.DATA, 'map-layers.csv'))
			.pipe(parse({ columns: true }))
			.on('data', (row: Record<string, string>) => {
				if (!row['Layer Name']) return
				if (row['Level']) currentMap = preprocessLevel(row['Level'])
				const layer = { Map: preprocessLevel(currentMap!), Layer: row['Layer Name'], Size: row['Layer Size*'] }
				const segments = L.parseLayerStringSegment(layer.Layer)
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

function parseBgLayerAvailability(ctx: CS.Log) {
	return new Promise<{ availability: Map<string, LC.LayerFactionAvailabilityEntry[]> }>((resolve, reject) => {
		const entries: Map<string, LC.LayerFactionAvailabilityEntry[]> = new Map()
		const col = {
			Layer: 2,
			Faction: 3,
			Unit: 4,
			UnitFullName: 5,
			TeamOptions: 6,
			sheetLink: 8,
		}

		let currentLayers: string[] | undefined
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
					if (row[col.Layer].toLowerCase().startsWith('tutorial')) {
						currentLayers = undefined
						return
					}
					currentLayers = [row[col.Layer]]
					entries.set(row[col.Layer], [])
					const segments = L.parseLayerStringSegment(row[col.Layer])
					if (!segments) throw new Error(`Invalid layer string segment: ${currentLayers}`)
					if (segments.Gamemode === 'RAAS') {
						const fraasLayer = row[col.Layer].replace('RAAS', 'FRAAS')
						entries.set(fraasLayer, [])
						currentLayers.push(fraasLayer)
					}
					return
				}
				let unit: string | undefined
				let isDefaultUnit = false
				if (!currentLayers) return
				for (const currentLayer of currentLayers) {
					if (currentLayer.startsWith('JensensRange')) {
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
					const entry = { Layer: currentLayers!, Faction: currentFaction!, Unit: unit, allowedTeams: teams, isDefaultUnit }
					entries.get(currentLayer)!.push(entry)
					if (currentLayer.toLowerCase().includes('sanxian') || currentLayer.toLowerCase().includes('pacificprovinggrounds')) {
						// RGF and PLA are excluded on sanxian, so we add them here. if we add them in addition to both a blufor and CCP faction we should get the correct availability
						if (entry.Faction === 'PLA' || entry.Faction === 'USMC') {
							for (const faction of ['RGF', 'VDV']) {
								const existing = entries.get(currentLayer)!.find(e => e.Faction === faction && e.Unit === unit)
								if (!existing) {
									entries.get(currentLayer)!.push({ ...entry, Faction: faction })
								} else {
									existing.allowedTeams = Array.from(new Set([...existing.allowedTeams, ...teams]))
								}
							}
						}
					}
				}
			})
			.on('end', () => {
				ctx.log.info(`Parsed ${entries.size} layers for availability`)
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
