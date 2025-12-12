import * as Paths from '$root/paths'
import * as MapUtils from '@/lib/map'
import * as OneToMany from '@/lib/one-to-many-map'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import { ParsedFloatSchema, ParsedIntSchema, StrFlag } from '@/lib/zod'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as SLL from '@/models/squad-layer-list.models'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import * as LayerDb from '@/server/systems/layer-db'
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

const Steps = z.enum(['update-layers-table', 'download-csvs', 'write-components-and-units'])

const envBuilder = Env.getEnvBuilder({ ...Env.groups.preprocess, ...Env.groups.layerDb })
let ENV!: ReturnType<typeof envBuilder>

async function main() {
	const args = z.array(Steps).parse(process.argv.slice(2))
	if (args.length === 0) {
		args.push('update-layers-table', 'write-components-and-units')
	}
	Env.ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()

	LayerDb.setupExtraColsConfig()
	const ctx = { log: baseLogger, effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG) }

	L.lockStaticFactionUnitConfigs()
	L.lockStaticLayerComponents()
	await ensureAllSheetsDownloaded(ctx, { invalidate: args.includes('download-csvs') })

	const data = await parseSquadLayerSheetData(ctx)
	const components = LC.toLayerComponentsJson(LC.buildFullLayerComponents(data.components))
	L.setStaticLayerComponents(components)

	if (args.includes('write-components-and-units')) {
		await Promise.all([
			fsPromise.writeFile(path.join(Paths.ASSETS, 'layer-components.json'), JSON.stringify(components, null, 2)),
			fsPromise.writeFile(path.join(Paths.ASSETS, 'factionunit-configs.json'), JSON.stringify(data.units, null, 2)),
		])
	}

	const outerCtx = ctx
	if (args.includes('update-layers-table')) {
		await LayerDb.setup({ skipHash: true, mode: 'populate', logging: false })
		const ctx = { ...outerCtx, layerDb: () => LayerDb.db }
		// drizzle-kit push doesn't appear to account for views
		ctx.layerDb().run(sql`drop view if exists ${LC.layersView(ctx)}`)
		ctx.log.info('executing drizzle-kit push')
		childProcess.spawnSync('pnpm', ['drizzle-kit', 'push', '--config', 'drizzle-layersdb.config.ts'])

		await extractLayerScores(ctx, components)
		await populateLayersTable(ctx, components, Rx.from(data.baseLayers))

		ctx.layerDb().run('PRAGMA wal_checkpoint')
		ctx.layerDb().run('PRAGMA optimize')
		ctx.layerDb().run('VACUUM')
		ctx.layerDb().$client.close()
		ctx.log.info('Done! Wrote layers to %s', ENV.LAYERS_DB_PATH)
	}
}

async function extractLayerScores(ctx: CS.Log & CS.LayerDb, components: LC.LayerComponentsJson): Promise<void> {
	const extraColsZodProps: Record<string, z.ZodType> = {}
	for (const col of LayerDb.LAYER_DB_CONFIG.columns) {
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
	fs.createReadStream(ENV.EXTRA_COLS_CSV_PATH, 'utf8')
		.pipe(
			parse({
				columns: true,
				skip_empty_lines: true,
			}),
		)
		.on('data', (row) => {
			if (row.Scored === 'False') return
			if (row.SubFac_1) row.Unit_1 = row.SubFac_1
			if (row.SubFac_2) row.Unit_2 = row.SubFac_2

			let segments = L.parseLayerStringSegment(row['Layer'])
			if (!segments) throw new Error(`Layer ${row['Layer']} is invalid`)
			segments = L.applyBackwardsCompatMappings(segments, components)

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
			if (ids[0] === null) return
			// for now we're just using the same data for FRAAS as RAAS
			if (segments.Gamemode === 'RAAS') {
				ids.push(L.getKnownLayerId({ ...idArgs, Gamemode: 'FRAAS' }, components)!)
			}
			const extraColsRow = extraColsZodSchema.parse(row)
			for (const layerId of ids) {
				if (!L.isKnownLayer(L.toLayer(layerId, components), components)) {
					ctx.log.warn(`Unknown layer ${layerId}`)
					continue
				}
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
						value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint'
						&& !Buffer.isBuffer(value)
					) {
						ctx.log.error(`Invalid value type for key "${key}":`, typeof value, value)
						throw new Error(`Invalid SQLite value type for key "${key}": ${typeof value} (${JSON.stringify(value)})`)
					}
				}
			}
			const values = buf.map(layer => ({
				...layer,
				id: LC.packId(layer.id, components),
			}))
			if (values.length > 0) {
				await ctx.layerDb().insert(LC.extraColsSchema(ctx)).values(values)
			}
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
	ctx: CS.Log & CS.LayerDb,
	components: LC.LayerComponentsJson,
	finalLayers: Rx.Observable<L.KnownLayer>,
) {
	const t0 = performance.now()

	// -------- process layers --------
	ctx.log.info('Truncating layers table')
	ctx.layerDb().run(sql`DELETE FROM ${LC.layers} `)
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
			await ctx.layerDb().insert(LC.layers).values(buf.map(layer => LC.toRow(layer, ctx, components)))
			chunkCount++
		}),
	))

	const t1 = performance.now()
	const elapsedSecondsInsert = (t1 - t0) / 1000
	ctx.log.info(`Inserting ${chunkCount * 500} rows took ${elapsedSecondsInsert} s`)
}

async function parseSquadLayerSheetData(ctx: CS.Log) {
	const json = SLL.RootSchema.parse(
		JSON.parse(await fsPromise.readFile(path.join(Paths.DATA, 'squad-layer-list.json'), 'utf-8').then(res => res)),
	)
	const { allianceToFaction, factionToUnit, factionUnitToUnitFullName } = parseBattlegroups(ctx, json)
	const availability: Map<string, L.LayerFactionAvailabilityEntry[]> = new Map()
	const factionToAlliance = OneToMany.invertOneToOne(allianceToFaction)
	const sizes = await getMapLayerSizes()

	const mapLayers: L.LayerConfig[] = []
	for (const map of json.Maps) {
		if (map.levelName.includes('Automation')) continue
		if (map.levelName.toLowerCase().includes('tutorial')) continue
		const segments = L.parseLayerStringSegment(map.levelName)
		if (!segments) {
			ctx.log.error(`Invalid layer name: ${map.levelName}`)
			continue
		}
		const size = sizes.get(map.levelName) ?? 'Small'
		if (!size) {
			ctx.log.error(`${map.levelName} has unknown size`)
		}
		if (!map.teamConfigs.team1 || !map.teamConfigs.team2) continue
		const teamConfigs = Object.entries(map.teamConfigs).sort((a, b) => a[0].localeCompare(b[0])).map(([_, team]) => team)
		const baseConfig = {
			...segments,
			Size: size,
			Layer: map.levelName,

			hasCommander: map.commander,
			persistentLightingType: map.persistentLightingType,
		}

		const availForLayer: L.LayerFactionAvailabilityEntry[] = []
		availability.set(map.levelName, availForLayer)
		if (segments.layerType === 'training') {
			availForLayer.push(
				{
					Faction: segments.extraFactions[0],
					Unit: 'CombinedArms',
					allowedTeams: [1],
					isDefaultUnit: true,
				},
				{
					Faction: segments.extraFactions[1],
					Unit: 'CombinedArms',
					allowedTeams: [2],
					isDefaultUnit: true,
				},
			)
			mapLayers.push({
				...baseConfig,
				teams: [
					{
						defaultFaction: segments.extraFactions[0],
						tickets: map.teamConfigs.team1.tickets,
					},
					{
						defaultFaction: segments.extraFactions[1],
						tickets: map.teamConfigs.team2.tickets,
					},
				],
			})
			continue
		}
		mapLayers.push({
			...baseConfig,
			teams: teamConfigs.map((t): L.MapConfigTeam => {
				const defaultFaction = t.defaultFactionUnit.split('_')[0]
				let role: L.MapConfigTeam['role']
				if (L.ASYMM_GAMEMODES.includes(segments.Gamemode)) {
					if (t.isAttackingTeam) role = 'attack'
					if (t.isDefendingTeam) role = 'defend'
				}

				return {
					defaultFaction,
					tickets: t.tickets,
					role,
				}
			}),
		})
		for (const faction of map.factions) {
			const idDetails = json.Units[faction.defaultUnit]
			const units = new Set(faction.types)
			const parsedId = SLL.parseUnitId(idDetails.unitObjectName)
			units.add(parsedId.unit)
			const parsedDefaultUnit = SLL.parseUnitId(faction.defaultUnit)
			for (const unit of units) {
				availForLayer.push({
					Faction: faction.factionId,
					Unit: unit,
					allowedTeams: faction.availableOnTeams,
					isDefaultUnit: parsedDefaultUnit.unit == unit,
					variants: {
						boats: faction.defaultUnit.includes('Boats'),
						noHeli: faction.defaultUnit.includes('NoHeli'),
					},
				})
			}
		}
	}

	const baseLayers: L.KnownLayer[] = []
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

				let parsedSegments = L.parseLayerStringSegment(layer.Layer)
				if (!parsedSegments) throw new Error(`Invalid layer string segment: ${layer.Layer}`)
				parsedSegments = L.applyBackwardsCompatMappings(parsedSegments, LC.toLayerComponentsJson(components))
				components.alliances.add(factionToAlliance.get(availEntry1.Faction)!)
				components.alliances.add(factionToAlliance.get(availEntry2.Faction)!)
				components.versions.add(parsedSegments.LayerVersion)
				components.gamemodes.add(parsedSegments.Gamemode)
				components.factions.add(availEntry1.Faction)
				components.factions.add(availEntry2.Faction)
				if (availEntry1.Unit) components.units.add(availEntry1.Unit)
				if (availEntry2.Unit) components.units.add(availEntry2.Unit)
				if (!parsedSegments) throw new Error(`Invalid layer string segment: ${layer.Layer}`)
				const idArgs = {
					Map: layer.Map,
					LayerVersion: parsedSegments.LayerVersion,
					Gamemode: parsedSegments.Gamemode,
					Faction_1: availEntry1.Faction,
					Faction_2: availEntry2.Faction,
					Unit_1: availEntry1.Unit ?? null,
					Unit_2: availEntry2.Unit ?? null,
				}
				const layerId = L.getKnownLayerId(idArgs, LC.toLayerComponentsJson(components))!
				if (layerId === null) throw new Error(`Invalid layer ID: ${JSON.stringify(idArgs)}`)
				const baseLayer: L.KnownLayer = {
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

	// -------- include FRAAS --------
	components.gamemodes.add('FRAAS')
	for (const layer of Array.from(components.layers)) {
		components.layers.add(layer.replace('RAAS', 'FRAAS'))
	}

	const layersToAdd: L.KnownLayer[] = []
	let i = 0
	for (const layer of baseLayers) {
		if (layer.Gamemode !== 'RAAS') continue
		const fraasVariant = L.getFraasVariant(layer)
		components.layers.add(fraasVariant.Layer)
		layersToAdd.push(fraasVariant)
		idToIdx.set(fraasVariant.id, i + baseLayers.length)
		i++
	}
	baseLayers.push(...layersToAdd)

	const mapLayersToAdd: L.LayerConfig[] = []
	for (const layerConfig of components.mapLayers) {
		if (layerConfig.Gamemode !== 'RAAS') continue
		const newLayerConfig = { ...layerConfig }
		newLayerConfig.Gamemode = 'FRAAS'
		newLayerConfig.Layer = newLayerConfig.Layer.replace('RAAS', 'FRAAS')
		mapLayersToAdd.push(newLayerConfig)
	}
	components.mapLayers.push(...mapLayersToAdd)

	const addedAvailability = new Map<string, L.LayerFactionAvailabilityEntry[]>()
	for (const [key, entries] of components.layerFactionAvailability.entries()) {
		if (!key.includes('RAAS')) continue

		addedAvailability.set(key.replace('RAAS', 'FRAAS'), entries)
	}
	components.layerFactionAvailability = MapUtils.union(addedAvailability, components.layerFactionAvailability)

	ctx.log.info('Parsed %s total layers', baseLayers.length)
	return { baseLayers, idToIdx, components, units: json.Units }
}

function parseBattlegroups(ctx: CS.Log, root: SLL.Root) {
	const allianceToFaction: OneToManyMap<string, string> = new Map()
	const factionToUnit: OneToManyMap<string, string> = new Map()
	const factionUnitToFullUnitName: Map<`${string}:${string}`, string> = new Map()

	// Extract data from LayerListData.Units
	for (const unit of Object.values(root.Units)) {
		const alliance = unit.alliance
		const faction = unit.factionID
		const unitName = unit.type

		// Map alliance to faction
		OneToMany.set(allianceToFaction, alliance, faction)

		// Map faction to unit
		OneToMany.set(factionToUnit, faction, unitName)

		// Map faction:unit to full unit name
		factionUnitToFullUnitName.set(`${faction}:${unitName}`, unit.displayName)
	}

	ctx.log.info(`Parsed ${allianceToFaction.size} alliance to faction mappings`)
	ctx.log.info(`Parsed ${factionToUnit.size} faction to unit mappings`)
	ctx.log.info(`Parsed ${factionUnitToFullUnitName.size} faction unit to full unit name mappings`)

	return { allianceToFaction, factionToUnit, factionUnitToUnitFullName: factionUnitToFullUnitName }
}

function getMapLayerSizes() {
	return new Promise<Map<string, string>>((resolve, reject) => {
		const sizeMapping: Map<string, string> = new Map()
		fs.createReadStream(path.join(Paths.DATA, 'map-layers.csv'))
			.pipe(parse({ columns: true }))
			.on('data', (row: Record<string, string>) => {
				if (!row['Layer Name']) return
				const size = row['Layer Size*']
				const layer = row['Layer Name']
				sizeMapping.set(layer, size)
			})
			.on('end', () => {
				resolve(sizeMapping)
			})
			.on('error', (error) => {
				console.error('Error parsing map layers CSV:', error)
				reject(error)
			})
	})
}

async function ensureAllSheetsDownloaded(ctx: CS.Log, opts?: { invalidate?: boolean }) {
	const invalidate = opts?.invalidate ?? false
	const ops: Promise<void>[] = []
	const sheets = [
		{
			name: 'mapLayers',
			filename: 'map-layers.csv',
			gid: ENV.SPREADSHEET_MAP_LAYERS_GID,
		},
	]
	for (const sheet of sheets) {
		const sheetPath = path.join(Paths.DATA, sheet.filename)
		if (invalidate || !fs.existsSync(sheetPath)) {
			ops.push(downloadPublicSheetAsCSV(ctx, sheet.gid, sheetPath))
		}
	}
	await Promise.all(ops)
}

async function downloadPublicSheetAsCSV(ctx: CS.Log, gid: number, filepath: string) {
	const url = `https://docs.google.com/spreadsheets/d/${ENV.SPREADSHEET_ID}/export?gid=${gid}&format=csv#gid=${gid}`

	return await new Promise<void>((resolve, reject) => {
		const file = fs.createWriteStream(filepath)

		http.https.get(url, (response) => {
			response.pipe(file)

			file.on('finish', () => {
				file.close()
				ctx.log.info(`CSV downloaded successfully to %s`, filepath)
				resolve()
			})

			file.on('error', (error) => {
				file.close()
				ctx.log.error(error, `Error downloading CSV from %s to %s`, url, filepath)
				reject(error)
			})
		}).on('error', (error) => {
			ctx.log.error(error, 'Error downloading CSV:')
			reject(error)
		})
	})
}

await main()

process.exit(0)
