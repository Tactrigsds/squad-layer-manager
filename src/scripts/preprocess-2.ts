import { factions } from '$root/drizzle/schema'
import * as Obj from '@/lib/object'
import * as OneToMany from '@/lib/one-to-many-map'
import { OneToManyMap } from '@/lib/one-to-many-map'
import * as M from '@/models'
import * as Env from '@/server/env'
import { ensureEnvSetup } from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'
import * as Paths from '@/server/paths'
import { parse } from 'csv-parse'
import http from 'follow-redirects'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'

const Steps = z.enum(['download-csvs'])
const envBuilder = Env.getEnvBuilder({ ...Env.groups.sheets })
let ENV!: ReturnType<typeof envBuilder>

const gids = {
	battlegroups: 1796438364,
	alliances: 337815939,
	biomes: 1025614852,
	bgDescriptions: 104824254,
	bgLayerAvailability: 1881530590,
	mapLayers: 1212962563,
}

type BaseLayerComponents = {
	maps: Set<string>
	layers: Set<string>
	gamemodes: Set<string>
	versions: Set<string>
	factions: Set<string>
	subfactions: Set<string | null>
}

async function main() {
	ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()
	const args = z.array(Steps).parse(process.argv.slice(2))
	//  if (args.length === 0) {
	// 	args.push(...Obj.objKeys(Steps.Values))
	// }

	if (args.includes('download-csvs')) {
		await Promise.all([
			downloadPublicSheetAsCSV(gids.battlegroups, path.join(Paths.DATA, 'battlegroups.csv')),
			downloadPublicSheetAsCSV(gids.biomes, path.join(Paths.DATA, 'biomes.csv')),
			downloadPublicSheetAsCSV(gids.mapLayers, path.join(Paths.DATA, 'map-layers.csv')),
			downloadPublicSheetAsCSV(gids.bgLayerAvailability, path.join(Paths.DATA, 'bg-layer-availability.csv')),
		])
	}
	const layers = await parseMapLayers()
	const { allianceToFaction, factionToUnit, factionUnitToFullUnitName } = await parseBattlegroups()

	const { availability } = await parseBgLayerAvailability(factionToUnit, factionUnitToFullUnitName)
	const factionToAlliance = OneToMany.invertOneToOne(allianceToFaction)

	const layerCombs: { Layer: string; Size: string; Faction_1: string; Unit_1: string; Faction_2: string; Unit_2: string }[] = []

	for (const layer of layers) {
		for (const availEntry1 of availability) {
			if (availEntry1.Layer !== layer.Layer) continue
			if (!availEntry1.allowedTeams.includes(1)) continue
			for (const availEntry2 of availability) {
				if (!availEntry2.allowedTeams.includes(2)) continue
				if (availEntry2.Layer !== layer.Layer) continue
				const alliance1 = factionToAlliance.get(availEntry1.Faction)!
				const alliance2 = factionToAlliance.get(availEntry2.Faction)!
				if (alliance1 === alliance2 && alliance1 !== 'INDEPENDENT') continue
				layerCombs.push({
					Layer: layer.Layer,
					Faction_1: availEntry1.Faction,
					Unit_1: availEntry1.Unit,
					Faction_2: availEntry2.Faction,
					Unit_2: availEntry2.Unit,
					Size: layer.Size,
				})
			}
		}
	}
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

type FactionUnit = `${string}:${string}`
type BattlegroupsData = {
	allianceToFaction: OneToManyMap<string, string>
	factionToUnit: OneToManyMap<string, string>
	factionUnitToFullUnitName: Map<FactionUnit, string>
}
function parseBattlegroups() {
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
				console.log(`Parsed ${allianceToFaction.size} alliance to faction mappings`)
				console.log(`Parsed ${factionToUnit.size} faction to unit mappings`)
				console.log(`Parsed ${factionUnitToFullUnitName.size} faction unit to full unit name mappings`)

				resolve({ allianceToFaction, factionToUnit, factionUnitToFullUnitName })
			})
			.on('error', (error) => {
				console.error('Error parsing battlegroups CSV:', error)
				reject(error)
			})
	})
}
type LayerFactionAvailabilityEntry = {
	Layer: string
	Faction: string
	Unit: string
	allowedTeams: (1 | 2)[]
}

function parseMapLayers() {
	return new Promise<{ Layer: string; Size: string }[]>((resolve, reject) => {
		const layers: { Layer: string; Size: string }[] = []
		fs.createReadStream(path.join(Paths.DATA, 'map-layers.csv'))
			.pipe(parse({ columns: true }))
			.on('data', (row: Record<string, string>) => {
				if (!row['Layer Name']) return
				layers.push({ Layer: row['Layer Name'], Size: row['Layer Size*'] })
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

function parseBgLayerAvailability(
	factionToUnit: OneToManyMap<string, string>,
	factionUnitToFullUnitName: Map<FactionUnit, string>,
) {
	return new Promise<{ availability: LayerFactionAvailabilityEntry[] }>((resolve, reject) => {
		const entries: LayerFactionAvailabilityEntry[] = []
		const col = {
			Layer: 2,
			Faction: 3,
			Unit: 4,
			UnitFullName: 5,
			TeamOptions: 6,
			vehicleLink: 7,
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
				if (row[col.Faction]) {
					currentFaction = row[col.Faction]
					for (const u of factionToUnit.get(currentFaction)!.values()) {
						const fullNameRow = row[col.UnitFullName].replace(currentFaction, '').trim().toLowerCase()
						const fullNameForUnit = factionUnitToFullUnitName.get(`${row[col.Faction]}:${u}`)!.toLowerCase()
						if (fullNameRow.match(/^\d+/) && fullNameForUnit.match(/^\d+/)) {
							const rowNumber = fullNameRow.match(/^\d+/)?.[0]
							const unitNumber = fullNameForUnit.match(/^\d+/)?.[0]
							if (rowNumber === unitNumber) {
								unit = u
								break
							}
						}
						if (fullNameRow.includes(fullNameForUnit) || fullNameForUnit.includes(fullNameRow)) {
							unit = u
							break
						}
					}
					if (!unit) throw new Error(`Unit ${row[col.UnitFullName]} not found for faction ${row[col.Faction]}`)
				} else if (row[col.Unit]) {
					unit = row[col.Unit]
				} else {
					return
				}
				const teams: (1 | 2)[] = []
				if (row[col.TeamOptions].includes('1')) {
					teams.push(1)
				}
				if (row[col.TeamOptions].includes('2')) {
					teams.push(2)
				}
				entries.push({ Layer: currentLayer!, Faction: currentFaction!, Unit: unit, allowedTeams: teams })
			})
			.on('end', () => {
				console.log(`Parsed ${entries.length} layer availability entries`)
				resolve({ availability: entries })
			})
			.on('error', (error) => {
				console.error('Error parsing battlegroups CSV:', error)
				reject(error)
			})
	})
}

await main()
process.exit(0)
