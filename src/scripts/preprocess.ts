import * as Paths from '$root/paths'
import * as Arr from '@/lib/array'
import * as OneToMany from '@/lib/one-to-many-map'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import { ParsedFloatSchema, ParsedIntSchema } from '@/lib/zod'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as SLL from '@/models/squad-layer-list.models'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup, initModule } from '@/server/logger'
import * as LayerData from '@/systems/layer-data.server'
import * as LayerDb from '@/systems/layer-db.server'
import { parse } from 'csv-parse'
import { getTableColumns } from 'drizzle-orm'
import http from 'follow-redirects'
import * as fs from 'fs'
import * as fsPromise from 'fs/promises'
import { glob } from 'glob'
import childProcess from 'node:child_process'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import path from 'path'
import * as Rx from 'rxjs'

import { z } from 'zod'

const gzip = promisify(zlib.gzip)
const module = initModule('preprocess')

export const ParsedNanFloatSchema = z
	.string()
	.regex(/^\d+(\.\d+)?$/)
	.transform((val) => parseFloat(val))
	.pipe(z.number())

const ParsedNullableFloat = ParsedFloatSchema.transform((val) => (isNaN(val) ? null : val))

const Steps = z.enum(['update-layers-table', 'download-csvs', 'write-components-and-units', 'compress-db', 'all'])

const envBuilder = Env.getEnvBuilder({ ...Env.groups.preprocess, ...Env.groups.layerDb })
let ENV!: ReturnType<typeof envBuilder>
let log = baseLogger

async function main() {
	let args = z.array(Steps).parse(process.argv.slice(2))
	if (Arr.includes(args, 'all')) {
		args = [...Steps.options]
	} else if (args.length === 0) {
		args.push('update-layers-table', 'write-components-and-units', 'compress-db')
	}
	Env.ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()
	log = module.getLogger()

	LayerDb.setupExtraColsConfig()
	const ctx = { ...CS.init(), effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG) }

	const needsSheetData = args.includes('write-components-and-units') || args.includes('update-layers-table')
		|| args.includes('download-csvs')
	let data!: Awaited<ReturnType<typeof parseSquadLayerSheetData>>
	let components!: LC.LayerComponents
	if (needsSheetData) {
		await ensureAllSheetsDownloaded({ invalidate: args.includes('download-csvs') })
		data = await parseSquadLayerSheetData()
		components = LC.buildFullLayerComponents(data.components)
		L.setLayerData({ components, factionUnits: data.units })
	}

	if (args.includes('write-components-and-units')) {
		const file: L.LayerDataFile = {
			components: LC.toBaseLayerComponents(components),
			factionUnits: data.units,
		}
		await fsPromise.writeFile(path.join(Paths.DATA, LayerData.FILE_NAME), JSON.stringify(file, null, 2))
	}

	if (args.includes('update-layers-table')) {
		const [csvPath] = LayerDb.getVersionTemplatedPath(ENV.EXTRA_COLS_CSV_PATH)
		const dbPath = csvPath.replace(/\.csv$/, '.sqlite3')
		fs.rmSync(dbPath, { force: true })
		for (const file of glob.sync(`${dbPath}*`)) {
			fs.rmSync(file, { force: true })
		}

		const args = ['drizzle-kit', 'push', '--force', '--config', path.join(Paths.PROJECT_ROOT, 'drizzle-layersdb.config.ts')]
		const env = { ...process.env, LAYERS_DB_PATH: dbPath }
		log.info(`executing pnpm ${args.join(' ')} with env: %O`, { LAYERS_DB_PATH: dbPath })
		const res = childProcess.spawnSync('pnpm', args, { env })
		const stdout = res.stdout?.toString()
		if (stdout) {
			for (const line of stdout.split('\n')) {
				if (line.trim()) log.info('stdout: %s', line)
			}
		}
		const stderr = res.stderr?.toString()
		if (stderr) {
			for (const line of stderr.split('\n')) {
				if (line.trim()) log.info('stderr: %s', line)
			}
		}
		if (res.status !== 0) {
			throw new Error(`drizzle-kit push failed with status ${res.status}`)
		}

		await LayerDb.setup({ skipHash: true, mode: 'populate', logging: false, dbPath })
		const outerCtx = ctx
		{
			const ctx = { ...CS.init(), ...outerCtx, layerDb: () => LayerDb.db }

			// drop secondary indexes for the bulk inserts and rebuild them afterwards: maintaining
			// them per-row roughly doubles insert time, while a rebuild over the full table is one
			// sorted pass per index
			const droppedIndexes = ctx.layerDb().$client
				.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
				.all() as { name: string; sql: string }[]
			for (const idx of droppedIndexes) {
				ctx.layerDb().$client.exec(`DROP INDEX "${idx.name}"`)
			}

			await populateExtraColsTable(ctx, csvPath, components)
			await populateLayersTable(ctx, components, Rx.from(data.baseLayers))

			log.info('Rebuilding %s indexes', droppedIndexes.length)
			for (const idx of droppedIndexes) {
				ctx.layerDb().$client.exec(idx.sql)
			}

			ctx.layerDb().run('PRAGMA wal_checkpoint')
			ctx.layerDb().run('VACUUM')
			ctx.layerDb().run('PRAGMA optimize')
			await LayerDb.writePopulated(dbPath)
			ctx.layerDb().$client.close()
			log.info('Wrote layers to %s', dbPath)
		}
	}

	if (args.includes('compress-db')) {
		const [csvPath] = LayerDb.getVersionTemplatedPath(ENV.EXTRA_COLS_CSV_PATH)
		const dbPath = csvPath.replace(/\.csv$/, '.sqlite3')
		const gzipPath = `${dbPath}.gz`

		if (!fs.existsSync(dbPath)) {
			throw new Error(`Database file does not exist: ${dbPath}`)
		}

		log.info('Compressing database file %s to %s', dbPath, gzipPath)
		const buffer = await fsPromise.readFile(dbPath)
		// level 5 compresses ~40% faster than the default 6 for a ~0.1% size cost on this data
		const compressed = await gzip(buffer, { level: 5 })
		await fsPromise.writeFile(gzipPath, compressed)
	}
	log.info('Done!')
}

async function populateExtraColsTable(ctx: CS.LayerDb, csvPath: string, components: LC.LayerComponents): Promise<void> {
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
				schema = z.stringbool().transform(v => Number(v))
				break
			case 'float':
				// persist floats as ints scaled by 10^precision to shrink the table and its index;
				// read back via LC.fromScaledDbFloat
				schema = ParsedNullableFloat.transform(v => LC.toScaledDbFloat(col, v))
				break
			default:
				throw new Error(`Unsupported column type: ${(col as any).type}`)
		}
		extraColsZodProps[col.name] = schema
	}
	const extraColsZodSchema = z.object(extraColsZodProps)
	const insert = createInserter(ctx, 'layersExtra', ['id', ...LayerDb.LAYER_DB_CONFIG.columns.map(c => c.name)])

	const seenIds = new Set<string>()
	let inserted = 0
	let buf: Record<string, unknown>[] = []
	const flush = () => {
		insert(buf)
		inserted += buf.length
		log.info(`Inserted %s rows into extraCols`, inserted)
		buf = []
	}

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
		const ids = [L.getKnownLayerId(idArgs, components)!]
		if (ids[0] === null) continue
		// for now we're just using the same data for FRAAS as RAAS
		if (segments.Gamemode === 'RAAS') {
			ids.push(L.getKnownLayerId({ ...idArgs, Gamemode: 'FRAAS' }, components)!)
		}
		const extraColsRow = extraColsZodSchema.parse(row)
		for (const layerId of ids) {
			if (seenIds.has(layerId)) {
				log.warn(`Duplicate extra layer ${layerId} found`)
				continue
			}
			// packId validates the layer along the way, replacing a separate isKnownLayer pass
			let packedId: number
			try {
				packedId = LC.packId(layerId, components)
			} catch {
				log.warn(`Unknown layer ${layerId}`)
				continue
			}
			seenIds.add(layerId)

			buf.push({ ...extraColsRow, id: packedId })
			if (buf.length >= INSERT_CHUNK_SIZE) flush()
		}
	}
	flush()
	log.info('extraLayers insert completed')
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

const INSERT_CHUNK_SIZE = 20_000

// drizzle's query building dominates bulk-insert time, so inserts go through a raw prepared
// statement inside a transaction instead
function createInserter(ctx: CS.LayerDb, table: string, cols: string[]) {
	const driver = ctx.layerDb().$client
	const stmt = driver.prepare(
		`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
	)
	return driver.transaction((rows: Record<string, unknown>[]) => {
		for (const row of rows) {
			stmt.run(cols.map(c => row[c] ?? null))
		}
	})
}

async function populateLayersTable(
	ctx: CS.LayerDb,
	components: LC.LayerComponents,
	finalLayers: Rx.Observable<L.KnownLayer>,
) {
	const t0 = performance.now()

	// -------- process layers --------
	const insert = createInserter(ctx, 'layers', Object.keys(getTableColumns(LC.layers)))
	const seenIds: Set<string> = new Set()
	let inserted = 0
	await Rx.lastValueFrom(finalLayers.pipe(
		Rx.bufferCount(INSERT_CHUNK_SIZE),
		Rx.concatMap(async (buf) => {
			for (const layer of buf) {
				if (seenIds.has(layer.id)) {
					throw new Error(`Duplicate layer ID: ${layer.id}`)
				}
				seenIds.add(layer.id)
			}
			insert(buf.map(layer => LC.toRow(layer, ctx, components)))
			inserted += buf.length
			log.info(`Inserted %s rows into layers`, inserted)
		}),
	))

	const t1 = performance.now()
	const elapsedSecondsInsert = (t1 - t0) / 1000
	log.info(`Inserting ${inserted} rows took ${elapsedSecondsInsert} s`)
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
