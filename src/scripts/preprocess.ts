import * as fs from 'fs'
import * as fsPromise from 'fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import path from 'path'
import { z } from 'zod'

import * as Paths from '$root/paths'
import * as Arr from '@/lib/array-utils'
import * as OneToMany from '@/lib/one-to-many-map'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import * as ZodUtils from '@/lib/zod-utils'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LA from '@/models/layer-artifact'
import * as LC from '@/models/layer-columns'
import * as SLL from '@/models/squad-layer-list.models'
import * as VEH from '@/models/vehicles.models'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup, initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

const gzip = promisify(zlib.gzip)
const module = initModule('preprocess')

export const ParsedNanFloatSchema = z
	.string()
	.regex(/^\d+(\.\d+)?$/)
	.transform((val) => parseFloat(val))
	.pipe(z.number())

const ParsedNullableFloat = ZodUtils.ParsedFloatSchema.transform((val) => (isNaN(val) ? null : val))

const Steps = z.enum(['build-layer-artifact', 'write-components-and-units', 'compress-artifact', 'all'])

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
	let data!: Awaited<ReturnType<typeof parseSquadLayerSheetData>>
	let components!: LC.LayerComponents
	if (needsSheetData) {
		data = await parseSquadLayerSheetData()
		components = LC.buildFullLayerComponents(data.components)
		L.setLayerData({ components, factionUnits: data.units, extraColumns: LAYER_DB_CONFIG.columns })
	}

	// the version of a build comes from the csv it ingests, and both halves of the pair are stamped with it and
	// written side by side: the app will not load a table without the components that go with it.
	const writesArtifacts =
		args.includes('write-components-and-units') || args.includes('build-layer-artifact') || args.includes('compress-artifact')
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

// Builds the factored artifact the query engine reads (see models/layer-artifact.ts and layer-engine/src/store.rs).
//
// Two passes, so the whole table never exists as JS objects: first the base layers, which fix the row order (ascending
// packed id, which the engine binary-searches and which groups layers of a map together); then the extra-cols csv,
// whose rows are placed by looking their id up in that order. Columns are built straight into typed arrays with the
// null sentinels already written.
async function buildLayerArtifact(
	ctx: LC.Ctx,
	args: { components: LC.LayerComponents; baseLayers: PreprocessBaseLayer[]; csvPath: string; layersVersion: string },
): Promise<Buffer> {
	const { components, baseLayers, csvPath } = args
	const baseColumns = LC.COLUMN_KEYS.filter((key) => key !== 'id')

	const seen = new Set<string>()
	const rows: { id: number; values: number[]; unitRecords: [number, number] }[] = []
	for (const layer of baseLayers) {
		if (seen.has(layer.id)) {
			throw new Error(
				`Duplicate layer ID ${layer.id} (from layer ${layer.Layer}): two layers share Map/Gamemode/Version and factions; add a layerOverrides entry to the source manifest`,
			)
		}
		seen.add(layer.id)
		let row: Record<string, number | null>
		try {
			row = LC.toRow(layer, ctx, components) as Record<string, number | null>
		} catch (err) {
			throw new Error(`failed to pack layer ${JSON.stringify(layer)}`, { cause: err })
		}
		rows.push({
			id: Number(row.id),
			values: baseColumns.map((column) => (row[column] === null || row[column] === undefined ? -1 : row[column])),
			unitRecords: [layer.UnitRecord_1 ?? -1, layer.UnitRecord_2 ?? -1],
		})
	}
	rows.sort((a, b) => a.id - b.id)
	const rowCount = rows.length
	log.info('Building artifact for %s layers', rowCount)

	const ids = new Int32Array(rowCount)
	const baseKinds = baseColumns.map((name) => {
		const def = LC.BASE_COLUMN_DEFS[name] as LC.ColumnDef & { enumMapping: string }
		return LA.enumKind((components[def.enumMapping as keyof LC.LayerComponents] as unknown[]).length)
	})
	const baseNulls = baseKinds.map((kind) => (kind === 'u16' ? LA.NULL_U16 : LA.NULL_U8))
	const baseData = baseColumns.map((_, c) => (baseKinds[c] === 'u16' ? new Uint16Array(rowCount) : new Uint8Array(rowCount)))
	const unitRecordKind = LA.enumKind(components.unitRecords?.length ?? 0)
	const unitRecordNull = unitRecordKind === 'u16' ? LA.NULL_U16 : LA.NULL_U8
	const unitRecordData = ([0, 1] as const).map(() => (unitRecordKind === 'u16' ? new Uint16Array(rowCount) : new Uint8Array(rowCount)))
	for (let i = 0; i < rowCount; i++) {
		ids[i] = rows[i].id
		for (let c = 0; c < baseColumns.length; c++) {
			const value = rows[i].values[c]
			baseData[c][i] = value < 0 ? baseNulls[c] : value
		}
		for (const t of [0, 1] as const) {
			const value = rows[i].unitRecords[t]
			unitRecordData[t][i] = value < 0 ? unitRecordNull : value
		}
	}

	// extra columns start out entirely null: a layer the scores csv doesn't cover simply has no scores
	const extraDefs = LAYER_DB_CONFIG.columns
	// every extra is an i32 with one null sentinel, whatever its declared type: the factoring pass decides how each
	// one is actually stored (side record, difference, bitmap, dictionary) from the data rather than the declaration
	const extraData = extraDefs.map(() => new Int32Array(rowCount).fill(LA.NULL_I32))

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

	const factionAlliance = new Uint8Array(components.factions.length)
	for (let i = 0; i < components.factions.length; i++) {
		const alliance = components.factionToAlliance[components.factions[i]]
		const index = components.alliances.indexOf(alliance)
		if (index < 0) throw new Error(`faction ${components.factions[i]} has no alliance`)
		factionAlliance[i] = index
	}

	return LA.factorArtifact({
		rowCount,
		layersVersion: args.layersVersion,
		columns: [
			{ name: 'id', values: ids, nullValue: LA.NULL_I32 },
			...baseColumns.map((name, c) => ({ name, values: baseData[c], nullValue: baseNulls[c] })),
			{ name: LC.UNIT_RECORD_COLUMNS[1], values: unitRecordData[0], nullValue: unitRecordNull },
			{ name: LC.UNIT_RECORD_COLUMNS[2], values: unitRecordData[1], nullValue: unitRecordNull },
			...extraDefs.map((def, c) => ({ name: def.name, values: extraData[c], nullValue: LA.NULL_I32 })),
		],
		layerCount: components.layers.length,
		factionCount: components.factions.length,
		unitCount: components.units.length,
		factionAlliance,
		booleanColumns: new Set(extraDefs.filter((def) => def.type === 'boolean').map((def) => def.name)),
	})
}

function extraColSchema(col: LC.ColumnDef): z.ZodType {
	switch (col.type) {
		case 'string':
			throw new Error(`Extra column "${col.name}" is a string; the layer engine has no string column type yet`)
		case 'integer':
			return ZodUtils.ParsedIntSchema
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
// a real csv parser and its ~5x parsing overhead. bails if the no-quotes assumption ever breaks.
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

type LayerSource = { manifest: SLL.SourceManifest; root: SLL.Root; vocab: Set<string> }

function loadLayerSources(): LayerSource[] {
	const sourcesDir = path.join(Paths.DATA, 'sources')
	const names = fs
		.readdirSync(sourcesDir)
		.filter((dir) => fs.existsSync(path.join(sourcesDir, dir, 'source.json')))
		// vanilla first: on any cross-source disagreement (duplicate unit object names, battlegroup mappings) the
		// vanilla definition wins
		.sort((a, b) => (a === 'vanilla' ? -1 : b === 'vanilla' ? 1 : a.localeCompare(b)))
	if (names.length === 0) throw new Error(`no layer sources found in ${sourcesDir}`)
	return names.map((dir) => {
		const manifest = SLL.SourceManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(sourcesDir, dir, 'source.json'), 'utf-8')))
		if (manifest.name !== dir) throw new Error(`source ${dir}: manifest name "${manifest.name}" does not match its directory`)
		const rawRoot = JSON.parse(fs.readFileSync(path.join(sourcesDir, dir, 'layers.json'), 'utf-8'))
		const vocab = SLL.collectUnitTypeVocabulary(rawRoot, manifest)
		const root = SLL.createRootSchema(vocab, manifest.unitTypeOverrides).parse(rawRoot) as SLL.Root
		return { manifest, root, vocab }
	})
}

type ParsedSource = {
	mapLayers: L.LayerConfig[]
	availability: Map<string, L.LayerFactionAvailabilityEntry[]>
}

// (factionID, unit type, position, variants, seed/skirmish) identifies the Units record an availability entry
// resolves to. First-wins on the rare mod duplicates.
function buildUnitIndex(source: LayerSource): Map<string, string> {
	const index: Map<string, string> = new Map()
	for (const [name, unit] of Object.entries(source.root.Units)) {
		if (!unit.type) continue
		const parsed = SLL.parseUnitName(name, source.vocab, source.manifest.unitTypeOverrides)
		const segments = name.split(/[_-]/)
		const key = [
			unit.factionID,
			unit.type,
			parsed.position ?? '',
			parsed.variants.boats,
			parsed.variants.noHeli,
			segments.includes('Seed'),
			segments.includes('Skirmish'),
		].join('|')
		if (!index.has(key)) index.set(key, name)
	}
	return index
}

const SIZE_LETTERS: Record<string, string> = { Small: 'S', Medium: 'M', Large: 'L' }

function parseSourceLayers(source: LayerSource, componentsTemp: LC.LayerComponents): ParsedSource {
	const { manifest, root } = source
	const mapLayers: L.LayerConfig[] = []
	const availability: Map<string, L.LayerFactionAvailabilityEntry[]> = new Map()
	const unitIndex = buildUnitIndex(source)
	let unresolvedUnitNames = 0

	for (const map of root.Maps) {
		if (map.levelName.includes('Automation')) continue
		if (map.levelName.toLowerCase().includes('tutorial')) continue

		let segments: L.ParseLayerStringSegmentResult | null
		if (manifest.layerNames === 'parsed') {
			segments = L.parseLayerStringSegment(map.levelName, componentsTemp)
			if (!segments) {
				log.error(`${manifest.name}: invalid layer name: ${map.levelName}`)
				continue
			}
		} else {
			// the export's structured fields are the authority; the only thing still read out of the name is the
			// version, which has no field of its own ("V1-R" style weather variants keep their version)
			const versionMatch = map.levelName.match(/_[vV](\d+)(?:[_-]|$)/)
			segments = {
				layerType: 'normal',
				Map: map.mapId,
				Gamemode: manifest.gamemodeRenames[map.gamemode] ?? map.gamemode,
				LayerVersion: versionMatch ? `V${versionMatch[1]}` : null,
				Collection: manifest.collection.name,
				...manifest.layerOverrides[map.levelName],
			}
		}
		if (!map.teamConfigs.team1?.defaultFactionUnit || !map.teamConfigs.team2?.defaultFactionUnit) continue
		const size = deriveLayerSize(source, map)
		const teamConfigs = Object.entries(map.teamConfigs)
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([_, team]) => team)
		const baseConfig = {
			Map: segments.Map,
			Gamemode: segments.Gamemode,
			LayerVersion: segments.LayerVersion,
			Collection: segments.Collection,
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
				const defaultFaction = root.Units[t.defaultFactionUnit!]?.factionID ?? t.defaultFactionUnit!.split('_')[0]
				let role: L.MapConfigTeam['role']
				if (L.ASYMM_GAMEMODES.includes(segments!.Gamemode)) {
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
		const sizeLetter = SIZE_LETTERS[size] ?? 'S'
		const roleForTeam = (team: 1 | 2) => ((team === 1 ? map.teamConfigs.team1 : map.teamConfigs.team2)!.isDefendingTeam ? 'D' : 'O')
		const lookupUnitName = (faction: string, unit: string, team: 1 | 2, variants: { boats: boolean; noHeli: boolean }) => {
			const seed = segments!.Gamemode === 'Seed'
			const skirmish = segments!.Gamemode === 'Skirmish'
			const role = roleForTeam(team)
			const positions = sizeLetter === 'S' ? ['S'] : [`${sizeLetter}${role}`, `${sizeLetter}${role === 'O' ? 'D' : 'O'}`]
			for (const position of positions) {
				const name = unitIndex.get([faction, unit, position, variants.boats, variants.noHeli, seed, skirmish].join('|'))
				if (name) return name
			}
			return undefined
		}

		if (map.factions.length > 0) {
			for (const faction of map.factions) {
				if (!faction.defaultUnit) continue
				const idDetails = root.Units[faction.defaultUnit]
				if (!idDetails) {
					log.warn(`${manifest.name}: ${map.levelName}: default unit ${faction.defaultUnit} is not in Units`)
					continue
				}
				const parsedDefaultUnit = SLL.parseUnitName(faction.defaultUnit, source.vocab, manifest.unitTypeOverrides)
				const defaultType = parsedDefaultUnit.unit ?? idDetails.type
				const units = new Set(faction.types.filter((type) => type !== 'None'))
				if (idDetails.type) units.add(idDetails.type)
				if (units.size === 0) {
					log.warn(`${manifest.name}: ${map.levelName}: no unit types resolve for faction ${faction.factionId}`)
					continue
				}
				for (const unit of units) {
					const unitObjectNames: { 1?: string; 2?: string } = {}
					for (const team of faction.availableOnTeams) {
						const name =
							lookupUnitName(faction.factionId, unit, team, parsedDefaultUnit.variants) ??
							(unit === defaultType ? faction.defaultUnit : undefined)
						if (name) unitObjectNames[team] = name
						else unresolvedUnitNames++
					}
					availForLayer.push({
						Faction: faction.factionId,
						Unit: unit,
						allowedTeams: faction.availableOnTeams,
						isDefaultUnit: defaultType == unit,
						variants: parsedDefaultUnit.variants,
						...(Object.keys(unitObjectNames).length > 0 ? { unitObjectNames } : {}),
					})
				}
			}
		} else {
			// range/training layers of structured sources carry no factions list; the default units are all there is
			for (const [index, team] of teamConfigs.entries()) {
				const record = root.Units[team.defaultFactionUnit!]
				const parsed = SLL.parseUnitName(team.defaultFactionUnit!, source.vocab, manifest.unitTypeOverrides)
				const faction = record?.factionID ?? team.defaultFactionUnit!.split('_')[0]
				const teamNumber = (index + 1) as 1 | 2
				availForLayer.push({
					Faction: faction,
					Unit: record?.type ?? parsed.unit ?? 'CombinedArms',
					allowedTeams: [teamNumber],
					isDefaultUnit: true,
					variants: parsed.variants,
					...(record ? { unitObjectNames: { [teamNumber]: team.defaultFactionUnit! } } : {}),
				})
			}
		}
	}
	if (unresolvedUnitNames > 0) {
		log.warn(
			'%s: %s availability entries have no resolvable unit record; their layer details will degrade',
			manifest.name,
			unresolvedUnitNames,
		)
	}

	// Mods ship layers the id tuple cannot tell apart: weather variants, dev copies, gamemode fields that lie.
	// Manifest overrides resolve the ones worth naming; the rest get a version derived from a hash of the level
	// name, which is stable across data updates so a persisted id keeps meaning the same layer. Training layers
	// are exempt: their factions already tell them apart.
	if (manifest.layerNames === 'structured') {
		const tupleKey = (layer: L.LayerConfig) => `${layer.Map}|${layer.Gamemode}|${layer.LayerVersion}`
		const byTuple = new Map<string, L.LayerConfig[]>()
		for (const layer of mapLayers) {
			if (layer.Gamemode === 'Training') continue
			const key = tupleKey(layer)
			let group = byTuple.get(key)
			if (!group) byTuple.set(key, (group = []))
			group.push(layer)
		}
		const taken = new Set(byTuple.keys())
		for (const group of Array.from(byTuple.values())) {
			if (group.length < 2) continue
			group.sort((a, b) => a.Layer.localeCompare(b.Layer))
			for (const layer of group.slice(1)) {
				let hash = 2166136261
				for (const char of layer.Layer) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
				let version = 1000 + ((hash >>> 0) % 9000)
				while (taken.has(`${layer.Map}|${layer.Gamemode}|V${version}`)) version++
				layer.LayerVersion = `V${version}`
				taken.add(tupleKey(layer))
				log.warn(
					'%s: %s shares Map/Gamemode/Version with %s; its id uses the synthetic version V%s (name it with a layerOverrides entry instead if it matters)',
					manifest.name,
					layer.Layer,
					group[0].Layer,
					version,
				)
			}
		}
	}

	if (manifest.fraasVariants) {
		const fraasLayers: L.LayerConfig[] = []
		for (const layerConfig of mapLayers) {
			if (layerConfig.Gamemode !== 'RAAS') continue
			const fraasLayer = { ...layerConfig, Gamemode: 'FRAAS', Layer: layerConfig.Layer.replace('RAAS', 'FRAAS') }
			fraasLayers.push(fraasLayer)
			availability.set(fraasLayer.Layer, availability.get(layerConfig.Layer)!)
		}
		mapLayers.push(...fraasLayers)
	}

	return { mapLayers, availability }
}

// a base layer plus the unit-record indices (into components.unitRecords) each team resolved to, which
// only the artifact's UnitRecord_1/2 columns carry
type PreprocessBaseLayer = L.KnownLayer & { UnitRecord_1: number | null; UnitRecord_2: number | null }

async function parseSquadLayerSheetData() {
	const sources = loadLayerSources()

	const sourceAbbreviations: LC.SourceAbbreviations = { maps: {}, gamemodes: {}, units: {}, unitShortNames: {}, collections: {} }
	for (const { manifest } of sources) {
		Object.assign(sourceAbbreviations.maps, manifest.mapAbbreviations)
		Object.assign(sourceAbbreviations.gamemodes, manifest.gamemodeAbbreviations)
		for (const [unit, defs] of Object.entries(manifest.extraUnitTypes)) {
			sourceAbbreviations.units[unit] = defs.abbreviation
			sourceAbbreviations.unitShortNames[unit] = defs.shortName
		}
		sourceAbbreviations.collections[manifest.collection.name] = manifest.collection.abbreviation
	}

	const { allianceToFaction, factionToUnit, factionUnitToUnitFullName, factionUnits } = parseBattlegroups(sources)
	const { stats: vehicleStats, ...vehicleTables } = VEH.buildVehicleTables(factionUnits)
	log.info(
		'vehicle identity: %s distinct records in %s name groups -> %s canonical vehicles (%s split groups), %s classes',
		vehicleStats.records,
		vehicleStats.nameGroups,
		vehicleStats.canonical,
		vehicleStats.splitGroups.length,
		vehicleTables.vehicleTypes.length,
	)
	for (const split of vehicleStats.splitGroups) {
		log.debug('vehicle name "%s" split into: %s', split.name, split.names.join(', '))
	}
	if (vehicleStats.typelessVehicles.length > 0) {
		log.warn('%s canonical vehicles have no class: %s', vehicleStats.typelessVehicles.length, vehicleStats.typelessVehicles.join(', '))
	}
	// a mod faction may own no unit record (its availability points at another faction's units); its alliance then
	// comes from the default unit it borrows
	const alliancedFactions = new Set(Array.from(allianceToFaction.values()).flatMap((factions) => Array.from(factions)))
	for (const source of sources) {
		for (const map of source.root.Maps) {
			for (const faction of map.factions) {
				if (!faction.defaultUnit) continue
				const record = source.root.Units[faction.defaultUnit]
				if (record && !alliancedFactions.has(faction.factionId)) {
					OneToMany.set(allianceToFaction, record.alliance, faction.factionId)
					alliancedFactions.add(faction.factionId)
				}
			}
		}
	}
	const factionToAlliance = OneToMany.invertOneToOne(allianceToFaction)
	// @ts-expect-error it's fine
	const componentsTemp = LC.buildFullLayerComponents({ sourceAbbreviations }, true)

	const mapLayers: L.LayerConfig[] = []
	const availability: Map<string, L.LayerFactionAvailabilityEntry[]> = new Map()
	for (const source of sources) {
		const parsed = parseSourceLayers(source, componentsTemp)
		for (const [layer, entries] of parsed.availability) {
			if (availability.has(layer)) throw new Error(`layer ${layer} appears in more than one source`)
			availability.set(layer, entries)
		}
		mapLayers.push(...parsed.mapLayers)
		log.info('%s: parsed %s layers', source.manifest.name, parsed.mapLayers.length)
	}

	const baseLayers: PreprocessBaseLayer[] = []
	const components: LC.LayerComponents = LC.buildFullLayerComponents(
		{
			...vehicleTables,
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
			sourceAbbreviations,
		},
		true,
	)

	// Validate that all layers in availability are in mapLayers
	const layerNames = new Set(mapLayers.map((l) => l.Layer))
	for (const layer of availability.keys()) {
		if (!layerNames.has(layer)) {
			throw new Error(`Layer ${layer} from availability not found in mapLayers`)
		}
	}

	let unitRecordlessRows = 0
	const unitRecordIndex = (entry: L.LayerFactionAvailabilityEntry, team: 1 | 2): number | null => {
		const name = entry.unitObjectNames?.[team]
		const index = name === undefined ? -1 : LC.enumIndexOf(vehicleTables.unitRecords, name)
		if (index === -1) {
			unitRecordlessRows++
			return null
		}
		return index
	}

	for (const layer of mapLayers) {
		Arr.upsert(components.maps, layer.Map)
		Arr.upsert(components.size, layer.Size)
		Arr.upsert(components.layers, layer.Layer)
		const layerCollection = layer.Collection!
		if (!components.collections.includes(layerCollection)) {
			throw new Error(`Invalid collection: ${layerCollection}`)
		}
		// a source can list the same faction+unit more than once for a layer (variant default units); one row each
		const seenPairs = new Set<string>()
		for (const availEntry1 of availability.get(layer.Layer)!) {
			if (!availEntry1.allowedTeams.includes(1)) continue
			for (const availEntry2 of availability.get(layer.Layer)!) {
				if (!availEntry2.allowedTeams.includes(2)) continue

				if (availEntry1.Faction === availEntry2.Faction) continue
				const pairKey = `${availEntry1.Faction}|${availEntry1.Unit}|${availEntry2.Faction}|${availEntry2.Unit}`
				if (seenPairs.has(pairKey)) continue
				seenPairs.add(pairKey)

				Arr.upsert(components.alliances, factionToAlliance.get(availEntry1.Faction)!)
				Arr.upsert(components.alliances, factionToAlliance.get(availEntry2.Faction)!)
				Arr.upsert(components.versions, layer.LayerVersion)
				Arr.upsert(components.gamemodes, layer.Gamemode)
				Arr.upsert(components.factions, availEntry1.Faction)
				Arr.upsert(components.factions, availEntry2.Faction)
				if (availEntry1.Unit) Arr.upsert(components.units, availEntry1.Unit)
				if (availEntry2.Unit) Arr.upsert(components.units, availEntry2.Unit)
				const idArgs = {
					Map: layer.Map,
					LayerVersion: layer.LayerVersion,
					Gamemode: layer.Gamemode,
					Collection: layerCollection,
					Faction_1: availEntry1.Faction,
					Faction_2: availEntry2.Faction,
					Unit_1: availEntry1.Unit ?? null,
					Unit_2: availEntry2.Unit ?? null,
				}
				const layerId = L.getKnownLayerId(idArgs, components)!
				if (layerId === null) throw new Error(`Invalid layer ID: ${JSON.stringify(idArgs)}`)
				const baseLayer: PreprocessBaseLayer = {
					UnitRecord_1: unitRecordIndex(availEntry1, 1),
					UnitRecord_2: unitRecordIndex(availEntry2, 2),
					id: layerId,
					Map: layer.Map,
					Layer: layer.Layer,
					Gamemode: layer.Gamemode,
					LayerVersion: layer.LayerVersion,
					Collection: layerCollection,
					Size: layer.Size,
					Faction_1: availEntry1.Faction,
					Unit_1: availEntry1.Unit ?? null,
					Faction_2: availEntry2.Faction,
					Unit_2: availEntry2.Unit ?? null,
					Alliance_1: factionToAlliance.get(availEntry1.Faction)!,
					Alliance_2: factionToAlliance.get(availEntry2.Faction)!,
				}
				baseLayers.push(baseLayer)
			}
		}
	}

	if (unitRecordlessRows > 0) {
		log.warn(
			'%s of %s per-team unit references resolve to no unit record; vehicle filters read those as unknown',
			unitRecordlessRows,
			baseLayers.length * 2,
		)
	}
	log.info('Parsed %s total layers', baseLayers.length)
	return { baseLayers, components, units: factionUnits }
}

function parseBattlegroups(sources: LayerSource[]) {
	const allianceToFaction: OneToManyMap<string, string> = new Map()
	const factionToUnit: OneToManyMap<string, string> = new Map()
	const factionUnitToFullUnitName: Map<`${string}:${string}`, string> = new Map()
	const factionUnits: Record<string, SLL.Unit> = {}
	let duplicateUnitNames = 0

	for (const source of sources) {
		for (const [unitName, unit] of Object.entries(source.root.Units)) {
			// sources ship modified copies of each other's units under the same object name; the first source
			// (vanilla) keeps the name
			if (factionUnits[unitName]) {
				duplicateUnitNames++
				continue
			}
			factionUnits[unitName] = unit

			OneToMany.set(allianceToFaction, unit.alliance, unit.factionID)
			if (unit.type) {
				OneToMany.set(factionToUnit, unit.factionID, unit.type)
				if (!factionUnitToFullUnitName.has(`${unit.factionID}:${unit.type}`)) {
					factionUnitToFullUnitName.set(`${unit.factionID}:${unit.type}`, unit.displayName)
				}
			}
		}
	}

	if (duplicateUnitNames > 0) log.warn('%s unit object names appear in more than one source; the first source wins', duplicateUnitNames)
	log.info(`Parsed ${allianceToFaction.size} alliance to faction mappings`)
	log.info(`Parsed ${factionToUnit.size} faction to unit mappings`)
	log.info(`Parsed ${factionUnitToFullUnitName.size} faction unit to full unit name mappings`)

	return { allianceToFaction, factionToUnit, factionUnitToUnitFullName: factionUnitToFullUnitName, factionUnits }
}

// a layer's size is the tier baked into its default unit ids: the position segment starts L(arge)/M(edium)/S(mall),
// e.g. BAF_LO_CombinedArms is a Large layer's unit. On the rare layer whose teams field different tiers, the larger wins.
const UNIT_POSITION_SIZES: Record<string, string> = { L: 'Large', M: 'Medium', S: 'Small' }
const SIZE_ORDER = ['Small', 'Medium', 'Large']

function deriveLayerSize(source: LayerSource, map: SLL.Map): string {
	const sizes = [map.teamConfigs.team1!, map.teamConfigs.team2!].map((team) => {
		const { position } = SLL.parseUnitName(team.defaultFactionUnit!, source.vocab, source.manifest.unitTypeOverrides)
		const size = position === null ? undefined : UNIT_POSITION_SIZES[position[0]]
		if (!size) {
			log.warn(`${source.manifest.name}: ${map.levelName}: no layer size in unit ${team.defaultFactionUnit}, assuming Small`)
			return 'Small'
		}
		return size
	})
	return sizes.reduce((a, b) => (SIZE_ORDER.indexOf(a) >= SIZE_ORDER.indexOf(b) ? a : b))
}

await main()

process.exit(0)
