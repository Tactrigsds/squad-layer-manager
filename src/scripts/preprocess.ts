import * as Paths from '$root/paths'
import * as Arr from '@/lib/array'
import * as OneToMany from '@/lib/one-to-many-map'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import { ParsedFloatSchema, ParsedIntSchema } from '@/lib/zod'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LA from '@/models/layer-artifact'
import * as LC from '@/models/layer-columns'
import * as SLL from '@/models/squad-layer-list.models'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup, initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import { parse } from 'csv-parse'
import http from 'follow-redirects'
import * as fs from 'fs'
import * as fsPromise from 'fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import path from 'path'

import { z } from 'zod'

const gzip = promisify(zlib.gzip)
const module = initModule('preprocess')

export const ParsedNanFloatSchema = z
	.string()
	.regex(/^\d+(\.\d+)?$/)
	.transform((val) => parseFloat(val))
	.pipe(z.number())

const ParsedNullableFloat = ParsedFloatSchema.transform((val) => (isNaN(val) ? null : val))

const Steps = z.enum(['build-layer-artifact', 'download-csvs', 'write-components-and-units', 'compress-artifact', 'all'])

Env.ensureEnvSetup()
const envBuilder = Env.getEnvBuilder({ ...Env.groups.preprocess, ...Env.groups.layers, ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
let log = baseLogger

// layer-db.json defines the extra columns to ingest from the layers csv. It is preprocess-time input only: the
// definitions are written into layer-data.json alongside the db they describe, so nothing reads this file at runtime.
let LAYER_DB_CONFIG!: LC.LayerDbConfig

const DEFAULT_LAYER_DB_CONFIG_PATH = './layer-db.json'

function readLayerDbConfig(): LC.LayerDbConfig {
	// the schema is emitted next to the file it validates so editors can complete/lint layer-db.json
	fs.writeFileSync(
		path.join(Paths.ASSETS, 'db-config-schema.json'),
		JSON.stringify(z.toJSONSchema(LC.LayerDbConfigSchema, { io: 'input' }), null, 2),
	)

	let raw: string
	try {
		raw = fs.readFileSync(ENV.LAYER_DB_CONFIG_PATH, 'utf-8')
	} catch {
		// an explicit path that can't be read is a misconfiguration; the default one just means "no extra columns"
		if (ENV.LAYER_DB_CONFIG_PATH !== DEFAULT_LAYER_DB_CONFIG_PATH) throw new Error(`Cannot access ${ENV.LAYER_DB_CONFIG_PATH}`)
		log.info('no %s: building the layer db with no extra columns', ENV.LAYER_DB_CONFIG_PATH)
		return { columns: [] }
	}

	const parsed = JSON.parse(raw)
	// generation moved to globalSettings.layerGeneration (migration 0072). the key is stripped on parse, so a file
	// that still carries it preprocesses fine but the weights do nothing -- say so rather than let someone tune a dead knob
	if (parsed?.generation !== undefined) {
		log.warn(
			'%s still contains a "generation" block. It has moved to global settings (Layer Generation) and is ignored here; remove it from the file.',
			ENV.LAYER_DB_CONFIG_PATH,
		)
	}
	return LC.LayerDbConfigSchema.parse(parsed)
}

async function main() {
	let args = z.array(Steps).parse(process.argv.slice(2))
	if (Arr.includes(args, 'all')) {
		args = [...Steps.options]
	} else if (args.length === 0) {
		args.push('build-layer-artifact', 'write-components-and-units', 'compress-artifact')
	}
	Env.ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()
	log = module.getLogger()

	LAYER_DB_CONFIG = readLayerDbConfig()
	const ctx = { ...CS.init(), effectiveColsConfig: LC.getEffectiveColumnConfig(LAYER_DB_CONFIG.columns) }

	const needsSheetData = args.includes('write-components-and-units') || args.includes('build-layer-artifact')
		|| args.includes('download-csvs')
	let data!: Awaited<ReturnType<typeof parseSquadLayerSheetData>>
	let components!: LC.LayerComponents
	if (needsSheetData) {
		await ensureAllSheetsDownloaded({ invalidate: args.includes('download-csvs') })
		data = await parseSquadLayerSheetData()
		components = LC.buildFullLayerComponents(data.components)
		L.setLayerData({ components, factionUnits: data.units, extraColumns: LAYER_DB_CONFIG.columns })
	}

	// the version of a build comes from the csv it ingests, and both halves of the pair are stamped with it and
	// written side by side: the app will not load a table without the components that go with it.
	const writesArtifacts = args.includes('write-components-and-units') || args.includes('build-layer-artifact')
		|| args.includes('compress-artifact')
	let csvPath!: string
	let layersVersion!: string
	let tablePath!: string
	if (writesArtifacts) {
		;[csvPath, layersVersion] = LayerArtifacts.getVersionTemplatedPath(ENV.EXTRA_COLS_CSV_PATH)
		tablePath = path.join(ENV.LAYERS_OUTPUT_DIR, LayerArtifacts.tableFileName(layersVersion))
		await fsPromise.mkdir(ENV.LAYERS_OUTPUT_DIR, { recursive: true })
	}

	if (args.includes('write-components-and-units')) {
		const file: L.LayerDataFile = {
			components: LC.toBaseLayerComponents(components),
			factionUnits: data.units,
			// the column defs ship with the db they describe, so the app never has to read layer-db.json
			extraColumns: LAYER_DB_CONFIG.columns,
		}
		const layerDataPath = path.join(ENV.LAYERS_OUTPUT_DIR, LayerArtifacts.layerDataFileName(layersVersion))
		await fsPromise.writeFile(layerDataPath, JSON.stringify(file, null, 2))
		log.info('Wrote %s', layerDataPath)
	}

	if (args.includes('build-layer-artifact')) {
		fs.rmSync(tablePath, { force: true })
		fs.rmSync(`${tablePath}.gz`, { force: true })

		const artifact = await buildLayerArtifact(ctx, {
			components,
			baseLayers: data.baseLayers,
			csvPath,
			layersVersion,
		})
		await fsPromise.writeFile(tablePath, artifact)
		log.info('Wrote %s (%s MB)', tablePath, (artifact.length / 1e6).toFixed(1))
	}

	if (args.includes('compress-artifact')) {
		if (!fs.existsSync(tablePath)) throw new Error(`Layer artifact does not exist: ${tablePath}`)

		log.info('Compressing %s', tablePath)
		const buffer = await fsPromise.readFile(tablePath)
		// level 5 compresses ~40% faster than the default 6 for a ~0.1% size cost on this data
		const compressed = await gzip(buffer, { level: 5 })
		await fsPromise.writeFile(`${tablePath}.gz`, compressed)
		log.info('Compressed to %s MB (%s)', (compressed.length / 1e6).toFixed(1), `${tablePath}.gz`)
	}

	log.info('Done!')
}

// Builds the columnar artifact the query engine reads (see models/layer-artifact.ts and layer-engine/src/store.rs).
//
// Two passes, so the whole table never exists as JS objects: first the base layers, which fix the row order (ascending
// packed id, which the engine binary-searches and which groups layers of a map together); then the extra-cols csv,
// whose rows are placed by looking their id up in that order. Columns are built straight into typed arrays with the
// null sentinels already written.
async function buildLayerArtifact(
	ctx: CS.EffectiveColumnConfig,
	args: { components: LC.LayerComponents; baseLayers: L.KnownLayer[]; csvPath: string; layersVersion: string },
): Promise<Buffer> {
	const { components, baseLayers, csvPath } = args
	const baseColumns = LC.COLUMN_KEYS.filter((key) => key !== 'id')

	const seen = new Set<string>()
	const rows: { id: number; values: number[] }[] = []
	for (const layer of baseLayers) {
		if (seen.has(layer.id)) throw new Error(`Duplicate layer ID: ${layer.id}`)
		seen.add(layer.id)
		const row = LC.toRow(layer, ctx, components) as Record<string, number | null>
		rows.push({
			id: Number(row.id),
			values: baseColumns.map((column) => (row[column] === null || row[column] === undefined ? -1 : row[column])),
		})
	}
	rows.sort((a, b) => a.id - b.id)
	const rowCount = rows.length
	log.info('Building artifact for %s layers', rowCount)

	const ids = new Int32Array(rowCount)
	const baseData = baseColumns.map(() => new Uint8Array(rowCount))
	for (let i = 0; i < rowCount; i++) {
		ids[i] = rows[i].id
		for (let c = 0; c < baseColumns.length; c++) {
			const value = rows[i].values[c]
			baseData[c][i] = value < 0 ? LA.NULL_U8 : value
		}
	}

	// extra columns start out entirely null: a layer the scores csv doesn't cover simply has no scores
	const extraDefs = LAYER_DB_CONFIG.columns
	const extraData = extraDefs.map((def) => {
		const kind = LA.columnKind({ ...def, table: 'extra-cols' })
		if (kind === 'u8') return new Uint8Array(rowCount).fill(LA.NULL_U8)
		const arr = new Int32Array(rowCount)
		arr.fill(LA.NULL_I32)
		return arr
	})

	const extraColsSchema = z.object(Object.fromEntries(extraDefs.map((col) => [col.name, extraColSchema(col)])))

	const seenExtra = new Set<number>()
	for (const row of readSimpleCsv(csvPath)) {
		if (row.Scored === 'False') continue
		if (row.SubFac_1) row.Unit_1 = row.SubFac_1
		if (row.SubFac_2) row.Unit_2 = row.SubFac_2

		let segments = L.parseLayerStringSegment(row['Layer'], components)
		if (!segments) throw new Error(`Layer ${row['Layer']} is invalid`)
		segments = L.applyBackwardsCompatMappings(segments, components)

		const idArgs = {
			Map: segments.Map,
			Gamemode: segments.Gamemode,
			LayerVersion: segments.LayerVersion,
			Collection: segments.Collection,
			Faction_1: row['Faction_1'],
			Faction_2: row['Faction_2'],
			Unit_1: row['Unit_1'],
			Unit_2: row['Unit_2'],
		}
		const layerIds = [L.getKnownLayerId(idArgs, components)!]
		if (layerIds[0] === null) continue
		// for now we're just using the same data for FRAAS as RAAS
		if (segments.Gamemode === 'RAAS') {
			layerIds.push(L.getKnownLayerId({ ...idArgs, Gamemode: 'FRAAS' }, components)!)
		}
		const parsed = extraColsSchema.parse(row) as Record<string, number | null>

		for (const layerId of layerIds) {
			let packedId: number
			try {
				// packId validates the layer along the way, replacing a separate isKnownLayer pass
				packedId = LC.packId(layerId, components)
			} catch {
				log.warn(`Unknown layer ${layerId}`)
				continue
			}
			if (seenExtra.has(packedId)) {
				log.warn(`Duplicate extra layer ${layerId} found`)
				continue
			}
			seenExtra.add(packedId)
			const index = binarySearch(ids, packedId)
			// scores for a layer the sheet no longer lists: nothing to attach them to
			if (index < 0) continue
			for (let c = 0; c < extraDefs.length; c++) {
				const value = parsed[extraDefs[c].name]
				if (value === null || value === undefined) continue
				extraData[c][index] = value
			}
		}
	}
	log.info('Attached extra columns for %s layers', seenExtra.size)

	return LA.writeArtifact({
		rowCount,
		layersVersion: args.layersVersion,
		columns: [
			{ name: 'id', kind: 'i32', values: ids },
			...baseColumns.map((name, c) => ({ name, kind: 'u8' as const, values: baseData[c] })),
			...extraDefs.map((def, c) => ({
				name: def.name,
				kind: LA.columnKind({ ...def, table: 'extra-cols' }),
				values: extraData[c],
			})),
		],
	})
}

function extraColSchema(col: LC.ColumnDef): z.ZodType {
	switch (col.type) {
		case 'string':
			throw new Error(`Extra column "${col.name}" is a string; the layer engine has no string column type yet`)
		case 'integer':
			return ParsedIntSchema
		case 'boolean':
			return z.stringbool().transform((v) => Number(v))
		case 'float':
			// floats persist as ints scaled by 10^precision, the same encoding the layer db used; read back via
			// LC.fromScaledDbFloat
			return ParsedNullableFloat.transform((v) => (v === null ? null : LC.toScaledDbFloat(col, v)))
		default:
			throw new Error(`Unsupported column type: ${(col as LC.ColumnDef).type}`)
	}
}

function binarySearch(haystack: Int32Array, needle: number): number {
	let lo = 0
	let hi = haystack.length - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const value = haystack[mid]
		if (value === needle) return mid
		if (value < needle) lo = mid + 1
		else hi = mid - 1
	}
	return -1
}

// the extra-cols csv is machine-generated and contains no quoted fields, which lets us skip
// csv-parse and its ~5x parsing overhead. bails if the no-quotes assumption ever breaks; the
// google-sheet csvs (map-layers.csv) can contain quotes and stay on csv-parse.
function* readSimpleCsv(csvPath: string): Generator<Record<string, string>> {
	const text = fs.readFileSync(csvPath, 'utf8')
	if (text.includes('"')) {
		throw new Error(`${csvPath} contains quoted fields, parse it with csv-parse instead`)
	}
	let pos = text.indexOf('\n')
	const header = text.slice(0, pos).split(',')
	const len = text.length
	while (pos !== -1 && pos < len - 1) {
		const next = text.indexOf('\n', pos + 1)
		const end = next === -1 ? len : next
		let line = text.slice(pos + 1, end)
		pos = next
		if (line.endsWith('\r')) line = line.slice(0, -1)
		if (!line) continue
		const parts = line.split(',')
		if (parts.length !== header.length) {
			throw new Error(`${csvPath}: expected ${header.length} fields, got ${parts.length}: ${line.slice(0, 200)}`)
		}
		const row: Record<string, string> = {}
		for (let i = 0; i < header.length; i++) row[header[i]] = parts[i]
		yield row
	}
}

async function parseSquadLayerSheetData() {
	const json = SLL.RootSchema.parse(
		JSON.parse(await fsPromise.readFile(path.join(Paths.DATA, 'squad-layer-list.json'), 'utf-8').then(res => res)),
	)
	const { allianceToFaction, factionToUnit, factionUnitToUnitFullName } = parseBattlegroups(json)
	const availability: Map<string, L.LayerFactionAvailabilityEntry[]> = new Map()
	const factionToAlliance = OneToMany.invertOneToOne(allianceToFaction)
	const sizes = await getMapLayerSizes()
	// @ts-expect-error it's fine
	const componentsTemp = LC.buildFullLayerComponents({}, true)

	const mapLayers: L.LayerConfig[] = []
	for (const map of json.Maps) {
		if (map.levelName.includes('Automation')) continue
		if (map.levelName.toLowerCase().includes('tutorial')) continue
		const segments = L.parseLayerStringSegment(map.levelName, componentsTemp)
		if (!segments) {
			log.error(`Invalid layer name: ${map.levelName}`)
			continue
		}
		const size = sizes.get(map.levelName) ?? 'Small'
		if (!size) {
			log.error(`${map.levelName} has unknown size`)
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

	let baseLayers: L.KnownLayer[] = []
	const idToIdx: Map<string, number> = new Map()
	const components: LC.LayerComponents = LC.buildFullLayerComponents(
		{
			mapLayers,
			allianceToFaction: Object.fromEntries(Array.from(allianceToFaction).map(([k, v]) => [k, Array.from(v)])),
			factionToAlliance: Object.fromEntries(factionToAlliance),
			factionToUnit: Object.fromEntries(Array.from(factionToUnit).map(([k, v]) => [k, Array.from(v)])),
			factionUnitToUnitFullName: Object.fromEntries(factionUnitToUnitFullName),
			layerFactionAvailability: Object.fromEntries(availability),
			gamemodes: [],
			alliances: [],
			maps: [],
			layers: [],
			versions: [],
			factions: [],
			units: [],
			size: [],
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
		Arr.upsert(components.maps, layer.Map)
		Arr.upsert(components.size, layer.Size)
		Arr.upsert(components.layers, layer.Layer)
		const rawSegments = L.parseLayerStringSegment(layer.Layer, components)
		if (!rawSegments) throw new Error(`Invalid layer string segment: ${layer.Layer}`)
		const parsedSegments = L.applyBackwardsCompatMappings(rawSegments, components)
		for (const availEntry1 of availability.get(layer.Layer)!) {
			if (!availEntry1.allowedTeams.includes(1)) continue
			for (const availEntry2 of availability.get(layer.Layer)!) {
				if (!availEntry2.allowedTeams.includes(2)) continue

				if (availEntry1.Faction === availEntry2.Faction) continue

				Arr.upsert(components.alliances, factionToAlliance.get(availEntry1.Faction)!)
				Arr.upsert(components.alliances, factionToAlliance.get(availEntry2.Faction)!)
				Arr.upsert(components.versions, parsedSegments.LayerVersion)
				if (!components.collections.includes(parsedSegments.Collection)) throw new Error(`Invalid collection: ${parsedSegments.Collection}`)
				if (!Object.keys(components.collectionAbbreviations).includes(parsedSegments.Collection)) {
					throw new Error(`Invalid collection (no abbreviation): ${parsedSegments.Collection}`)
				}
				Arr.upsert(components.gamemodes, parsedSegments.Gamemode)
				Arr.upsert(components.factions, availEntry1.Faction)
				Arr.upsert(components.factions, availEntry2.Faction)
				if (availEntry1.Unit) Arr.upsert(components.units, availEntry1.Unit)
				if (availEntry2.Unit) Arr.upsert(components.units, availEntry2.Unit)
				const idArgs = {
					Map: layer.Map,
					LayerVersion: parsedSegments.LayerVersion,
					Gamemode: parsedSegments.Gamemode,
					Collection: parsedSegments.Collection,
					Faction_1: availEntry1.Faction,
					Faction_2: availEntry2.Faction,
					Unit_1: availEntry1.Unit ?? null,
					Unit_2: availEntry2.Unit ?? null,
				}
				const layerId = L.getKnownLayerId(idArgs, components)!
				if (layerId === null) throw new Error(`Invalid layer ID: ${JSON.stringify(idArgs)}`)
				const baseLayer: L.KnownLayer = {
					id: layerId,
					Map: layer.Map,
					Layer: layer.Layer,
					Gamemode: parsedSegments.Gamemode,
					LayerVersion: parsedSegments.LayerVersion,
					Collection: parsedSegments.Collection,
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
		log.info('parsed layer configs for %s', layer.Layer)
	}

	// -------- include FRAAS --------
	Arr.upsert(components.gamemodes, 'FRAAS')
	for (const layer of Array.from(components.layers)) {
		Arr.upsert(components.layers, layer.replace('RAAS', 'FRAAS'))
	}

	const layersToAdd: L.KnownLayer[] = []
	let i = 0
	for (const layer of baseLayers) {
		if (layer.Gamemode !== 'RAAS') continue
		const fraasVariant = L.getFraasVariant(layer)
		Arr.upsert(components.layers, fraasVariant.Layer)
		layersToAdd.push(fraasVariant)
		idToIdx.set(fraasVariant.id, i + baseLayers.length)
		i++
	}
	baseLayers = baseLayers.concat(layersToAdd)

	const mapLayersToAdd: L.LayerConfig[] = []
	for (const layerConfig of components.mapLayers) {
		if (layerConfig.Gamemode !== 'RAAS') continue
		const newLayerConfig = { ...layerConfig }
		newLayerConfig.Gamemode = 'FRAAS'
		newLayerConfig.Layer = newLayerConfig.Layer.replace('RAAS', 'FRAAS')
		mapLayersToAdd.push(newLayerConfig)
	}
	components.mapLayers.push(...mapLayersToAdd)

	const addedAvailability: LC.LayerComponents['layerFactionAvailability'] = {}
	for (const [key, entries] of Object.entries(components.layerFactionAvailability)) {
		if (!key.includes('RAAS')) continue

		addedAvailability[key.replace('RAAS', 'FRAAS')] = entries
	}
	Object.assign(components.layerFactionAvailability, addedAvailability)

	log.info('Parsed %s total layers', baseLayers.length)
	return { baseLayers, idToIdx, components, units: json.Units }
}

function parseBattlegroups(root: SLL.Root) {
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

	log.info(`Parsed ${allianceToFaction.size} alliance to faction mappings`)
	log.info(`Parsed ${factionToUnit.size} faction to unit mappings`)
	log.info(`Parsed ${factionUnitToFullUnitName.size} faction unit to full unit name mappings`)

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

async function ensureAllSheetsDownloaded(opts?: { invalidate?: boolean }) {
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
			ops.push(downloadPublicSheetAsCSV(sheet.gid, sheetPath))
		}
	}
	await Promise.all(ops)
}

async function downloadPublicSheetAsCSV(gid: number, filepath: string) {
	const url = `https://docs.google.com/spreadsheets/d/${ENV.SPREADSHEET_ID}/export?gid=${gid}&format=csv#gid=${gid}`

	return await new Promise<void>((resolve, reject) => {
		const file = fs.createWriteStream(filepath)

		http.https.get(url, (response) => {
			response.pipe(file)

			file.on('finish', () => {
				file.close()
				log.info(`CSV downloaded successfully to %s`, filepath)
				resolve()
			})

			file.on('error', (error) => {
				file.close()
				log.error(error, `Error downloading CSV from %s to %s`, url, filepath)
				reject(error)
			})
		}).on('error', (error) => {
			log.error(error, 'Error downloading CSV:')
			reject(error)
		})
	})
}

await main()

process.exit(0)
