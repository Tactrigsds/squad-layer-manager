import * as fs from 'node:fs'
import * as path from 'node:path'

import * as Paths from '$root/paths'
import * as VEH from '@/models/vehicles.models'

// Rewrites the vehicle tables of the shipped layer-data files in place. `pnpm preprocess` also rebuilds them,
// but it needs the extra-columns csv that is not in the repo, and rebuilding without it drops every layer
// score. The vehicle tables derive from factionUnits, which layer-data already carries, so this needs no
// sources: it reads each file's own factionUnits and replaces the five arrays buildVehicleTables produces.
// Nothing else in the file moves, and the binary layer table is untouched -- it stores unit record indices,
// and unitRecords keeps its ordering.

const TABLE_KEYS = ['vehicles', 'vehicleTypes', 'vehicleTypeIds', 'unitRecords', 'unitRecordVehicles'] as const

const dir = path.join(Paths.ASSETS, 'layers')
for (const fileName of fs.readdirSync(dir).filter((name) => name.startsWith('layer-data_') && name.endsWith('.json'))) {
	const filePath = path.join(dir, fileName)
	const file = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
	// artifacts written before vehicle filtering carry no vehicle tables, and adding them here would ship
	// tables the accompanying binary was never built against
	if (!file.components?.vehicles) {
		console.log(`${fileName}: no vehicle tables, skipped`)
		continue
	}
	const { stats, ...tables } = VEH.buildVehicleTables(file.factionUnits)
	const changed = TABLE_KEYS.filter((key) => JSON.stringify(tables[key]) !== JSON.stringify(file.components[key]))
	for (const key of TABLE_KEYS) file.components[key] = tables[key]
	fs.writeFileSync(filePath, JSON.stringify(file, null, 2))
	console.log(
		`${fileName}: ${tables.vehicles.length} vehicles in ${tables.vehicleTypes.length} classes; rewrote [${changed.join(', ') || 'nothing'}]`,
	)
	if (stats.mixedLocomotion.length > 0) {
		console.log(`  ${stats.mixedLocomotion.length} vehicles merged records of differing locomotion: ${stats.mixedLocomotion.join(', ')}`)
	}
}
