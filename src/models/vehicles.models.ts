import type * as SLL from '@/models/squad-layer-list.models'

// Canonical vehicles: the query-facing identity of a vehicle, shared by every camo/faction/mod copy whose
// loadout is near-identical. Preprocess builds these tables from every source's unit records
// (buildVehicleTables); they ship in layer-data.json and back the Vehicle_*/VehicleType_* filter columns,
// which lower into membership tests over the artifact's UnitRecord_1/2 columns (see layer-engine.ts).
export type VehicleComponents = {
	// canonical vehicle names, the value list of the Vehicle_* columns
	vehicles: string[]
	// vehicle class vocabulary (TRAN/LOGI/MRAP/...), the value list of the VehicleType_* columns
	vehicleTypes: string[]
	// per canonical vehicle, its class as an index into vehicleTypes
	vehicleTypeIds: number[]
	// every Units record by object name; UnitRecord_1/2 column values index into this
	unitRecords: string[]
	// per unit record, the canonical vehicles in its composition, sorted ascending
	unitRecordVehicles: number[][]
}

// ---------------------------- runtime lookups ----------------------------

export function hasVehicleData(components: Partial<VehicleComponents>): components is VehicleComponents {
	return !!components.vehicles && !!components.unitRecords && !!components.unitRecordVehicles
}

// unit records whose composition contains any of the given canonical vehicles. The scan is over ~1.4k
// records with ~8 vehicles each, cheap enough to run per lowering.
export function unitRecordIdsForVehicles(vehicleIds: ReadonlySet<number>, components: VehicleComponents): number[] {
	const out: number[] = []
	for (let i = 0; i < components.unitRecordVehicles.length; i++) {
		if (components.unitRecordVehicles[i].some((id) => vehicleIds.has(id))) out.push(i)
	}
	return out
}

export function vehicleIdsForTypes(typeIds: ReadonlySet<number>, components: VehicleComponents): Set<number> {
	const out = new Set<number>()
	for (let i = 0; i < components.vehicleTypeIds.length; i++) {
		if (typeIds.has(components.vehicleTypeIds[i])) out.add(i)
	}
	return out
}

// ---------------------------- preprocess: the merge pass ----------------------------
// Query identity = normalized display name, guarded by loadout signals (class + weapon tags). Within a
// name group, records whose faction/cosmetic-stripped blueprint models overlap are the same loadout and
// merge, with conflicts in their metadata resolved by weighted majority; disjoint model sets are genuinely
// different vehicles sharing a label and stay separate under disambiguated names. The explicit tables
// below carry the human-reviewed dispositions (2026-08 vehicle identity review) the rule cannot infer.

const WEAPON_TAGS = new Set(['ATGM', 'AGL', 'RWS', 'LOW_CALIBER'])

// records whose display name is wrong in the source data, keyed by rowName
const ROW_NAME_OVERRIDES: Record<string, string> = {
	// mislabeled "BRDM-2"; a Spandrel-blueprint tank destroyer. Kept apart from "BRDM-2 Spandrel" per review.
	'SAA_BRDM-2-Konkurs': 'BRDM-2 Konkurs',
	// display names say Logistics but both are the TRAN variant
	'EIMF_Light-Truck_TRAN': 'Transport - Light Vehicle',
	SU_Lynx_TRAN: 'Lynx Transport',
	// same display name as the plain Tigr-M Kord but an RWS loadout on a BRDM-2 turret
	'EIMF_Tigr-M-Kord_BRDM-2_Turret': 'Tigr-M Kord BRDM-2 Turret',
}

// skin/context copies folded into their base vehicle, keyed by normalized name (Galactic Contention)
const NAME_MERGES: Record<string, string> = {
	'laat dev': 'LAAT',
	'laat skirmish': 'LAAT',
	'hmp dev': 'HMP',
	'hmp skirmish': 'HMP',
	'mini skiff blue': 'Mini Skiff',
	'tx 130 apc': 'TX-130',
	'tx 130 ge': 'TX-130',
	'tx 130 ge apc': 'TX-130',
	'arc170 ge': 'ARC170',
	'v wing ge': 'V-Wing',
	'atte ge': 'ATTE',
}

// classes for records whose cooked Setting omits the default-valued VehicleType (GC starfighters)
const VEH_TYPE_OVERRIDES: Record<string, string> = {
	arc170: 'AH',
	'v wing': 'AH',
	'tri fighter': 'AH',
	// nameless record (falls back to its rowName); a BTR-MDM turret carrier
	'su vdv btr mdm kord': 'APC',
}

// blueprint name tokens that vary between copies of the same vehicle: finishes, camos, damage/door/tent
// variants, mod markers. Faction ids are stripped separately, derived from the data.
const COSMETIC_TOKENS = new Set([
	'bp',
	'c',
	'spm',
	'supermod',
	'su',
	'naval',
	'parent',
	'pixel',
	'camo',
	'optic',
	'bag',
	'bench',
	'naked',
	'woodland',
	'desert',
	'black',
	'white',
	'blue',
	'green',
	'brown',
	'red',
	'yellow',
	'snorkel',
	'armoured',
	'armored',
	'closed',
	'open',
	'opened',
	'nodoor',
	'noroof',
	'notent',
	'noarch',
	'tentclosed',
	'tentopened',
	'nosportback',
	'nobackdoor',
	'nopassengertrunk',
	'noback',
	'nocanva',
	'noarmature',
	'rs',
	'insurgents',
	// faction spellings the blueprints use that no factionID quite matches
	'rus',
	'aus',
	'aussie',
	'brit',
	'us',
	'uk',
])

// same name and same guards would merge these, but the pools mix genuinely different chassis
// (GMV/UAZ/M998/Safir); they stay split per stripped blueprint model, per the review
const CHASSIS_SPLIT_NAMES = new Set(['logistics light vehicle'])

// reviewed merges the rule cannot infer: guard metadata conflicts (mod retypes, missing tags) with
// blueprints renamed too far for the model overlap check
const FORCE_MERGE_NAMES = new Set(['loach scout', 'm1151 technical dshk', 'technical bmp 1'])

function guardSig(record: VehicleRecord): string {
	return `${record.vehType}|${record.weaponTags}`
}

export function normalizeVehicleName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
}

function normalizeVehType(vehType: string, normName: string): string {
	if (VEH_TYPE_OVERRIDES[normName]) return VEH_TYPE_OVERRIDES[normName]
	// the cooked enum spells attack helicopters CAS; SquadLayerList's vocabulary is AH
	if (vehType === 'CAS') return 'AH'
	return vehType
}

type VehicleRecord = {
	key: string
	name: string
	normName: string
	vehType: string
	weaponTags: string
	models: Set<string>
	// the chassis token of the first blueprint, original case; names the extra clusters of a split group
	chassis: string
	refs: number
}

export type VehicleTableStats = {
	records: number
	nameGroups: number
	canonical: number
	splitGroups: { name: string; names: string[] }[]
	typelessVehicles: string[]
}

function stripModel(className: string, factionTokens: ReadonlySet<string>): string {
	const tokens = className
		.replace(/_C$/, '')
		.split(/[_-]/)
		.map((token) => token.toLowerCase())
		.filter((token) => token !== '' && !COSMETIC_TOKENS.has(token) && !factionTokens.has(token))
	// joined without separators, so BP_LAV-25 and BP_LAV25 read as the same model
	return tokens.join('')
}

class UnionFind {
	parents: number[]
	constructor(size: number) {
		this.parents = Array.from({ length: size }, (_, i) => i)
	}
	find(i: number): number {
		while (this.parents[i] !== i) {
			this.parents[i] = this.parents[this.parents[i]]
			i = this.parents[i]
		}
		return i
	}
	union(a: number, b: number) {
		this.parents[this.find(a)] = this.find(b)
	}
}

export function buildVehicleTables(factionUnits: Record<string, SLL.Unit>): VehicleComponents & { stats: VehicleTableStats } {
	const factionTokens = new Set<string>()
	for (const unit of Object.values(factionUnits)) {
		for (const token of unit.factionID.split(/[_-]/)) {
			factionTokens.add(token.toLowerCase())
			// mod factions carry era suffixes (UGF20, USA70) their blueprints spell without
			factionTokens.add(token.toLowerCase().replace(/\d+$/, ''))
		}
	}
	factionTokens.delete('')

	// collect distinct vehicle records, counting how many unit records reference each
	const records = new Map<string, VehicleRecord>()
	const unitRecordKeys = new Map<string, string[]>()
	for (const [unitName, unit] of Object.entries(factionUnits)) {
		const keys: string[] = []
		for (const vehicle of unit.vehicles) {
			// an empty display name falls back to the rowName; those records are each their own vehicle
			const rawName = vehicle.name !== '' ? vehicle.name : vehicle.rowName
			const overridden = ROW_NAME_OVERRIDES[vehicle.rowName] ?? NAME_MERGES[normalizeVehicleName(rawName)] ?? rawName
			const normName = normalizeVehicleName(overridden)
			const weaponTags = vehicle.tags
				.filter((tag) => WEAPON_TAGS.has(tag))
				.sort()
				.join(',')
			const vehType = normalizeVehType(vehicle.vehType, normName)
			const models = new Set(vehicle.classNames.map((c) => stripModel(c, factionTokens)).filter((m) => m !== ''))
			const chassis =
				vehicle.classNames
					.flatMap((c) =>
						c
							.replace(/_C$/, '')
							.split(/[_-]/)
							.filter((token) => {
								const lower = token.toLowerCase()
								return lower !== '' && !COSMETIC_TOKENS.has(lower) && !factionTokens.has(lower)
							}),
					)
					.at(0) ?? ''
			const key = [normName, vehType, weaponTags, Array.from(models).sort().join('|')].join('#')
			let record = records.get(key)
			if (!record) {
				records.set(key, (record = { key, name: overridden, normName, vehType, weaponTags, models, chassis, refs: 0 }))
			}
			record.refs++
			keys.push(key)
		}
		unitRecordKeys.set(unitName, keys)
	}

	// group by name, cluster by blueprint-model overlap
	const groups = new Map<string, VehicleRecord[]>()
	for (const record of records.values()) {
		let group = groups.get(record.normName)
		if (!group) groups.set(record.normName, (group = []))
		group.push(record)
	}

	type Cluster = { records: VehicleRecord[]; name: string }
	const clusterOf = new Map<string, Cluster>()
	const allClusters: Cluster[] = []
	const stats: VehicleTableStats = { records: records.size, nameGroups: groups.size, canonical: 0, splitGroups: [], typelessVehicles: [] }

	for (const group of groups.values()) {
		group.sort((a, b) => b.refs - a.refs || a.key.localeCompare(b.key))
		const uf = new UnionFind(group.length)
		const chassisSplit = CHASSIS_SPLIT_NAMES.has(group[0].normName)
		const forceMerge = FORCE_MERGE_NAMES.has(group[0].normName)
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				if (forceMerge) {
					uf.union(i, j)
				} else if (chassisSplit || guardSig(group[i]) !== guardSig(group[j])) {
					// blueprint models arbitrate: overlap means the same loadout under sloppy metadata
					const [small, large] = group[i].models.size <= group[j].models.size ? [group[i], group[j]] : [group[j], group[i]]
					if (small.models.size > 0 && Array.from(small.models).some((m) => large.models.has(m))) uf.union(i, j)
				} else {
					uf.union(i, j)
				}
			}
		}

		const clusters = new Map<number, VehicleRecord[]>()
		for (let i = 0; i < group.length; i++) {
			const root = uf.find(i)
			let cluster = clusters.get(root)
			if (!cluster) clusters.set(root, (cluster = []))
			cluster.push(group[i])
		}
		let ordered = Array.from(clusters.values()).sort((a, b) => refCount(b) - refCount(a) || a[0].key.localeCompare(b[0].key))
		// a split record with no usable blueprints carries no evidence it differs; fold it into the dominant cluster
		if (ordered.length > 1) {
			const orphans = ordered.filter((cluster) => cluster.every((record) => record.models.size === 0))
			if (orphans.length < ordered.length) {
				ordered = ordered.filter((cluster) => !orphans.includes(cluster))
				ordered[0].push(...orphans.flat())
			}
		}
		const built = ordered.map((clusterRecords, index): Cluster => {
			// the dominant record names the cluster; splits beyond the first are suffixed by a model token
			// unique to them, so same-named different vehicles stay distinguishable in the value list
			let name = clusterRecords[0].name
			if (index > 0)
				name = `${name} (${distinguishingToken(
					clusterRecords,
					ordered.filter((c) => c !== clusterRecords),
				)})`
			return { records: clusterRecords, name }
		})
		if (built.length > 1) stats.splitGroups.push({ name: built[0].name, names: built.map((c) => c.name) })
		for (const cluster of built) {
			allClusters.push(cluster)
			for (const record of cluster.records) clusterOf.set(record.key, cluster)
		}
	}

	// canonical tables, alphabetical for a stable UI value list
	allClusters.sort((a, b) => a.name.localeCompare(b.name))
	// name collisions across groups can only come from the disambiguation suffixes; make them unique
	const takenNames = new Set<string>()
	for (const cluster of allClusters) {
		let name = cluster.name
		for (let n = 2; takenNames.has(name); n++) name = `${cluster.name} ${n}`
		cluster.name = name
		takenNames.add(name)
	}

	const vehicles = allClusters.map((cluster) => cluster.name)
	const clusterIndex = new Map(allClusters.map((cluster, i) => [cluster, i]))
	const vehicleTypeNames = allClusters.map((cluster) => {
		// weighted majority among non-empty classes; guard conflicts within a merged cluster resolve here
		const counts = new Map<string, number>()
		for (const record of cluster.records) {
			if (record.vehType === '') continue
			counts.set(record.vehType, (counts.get(record.vehType) ?? 0) + record.refs)
		}
		const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
		if (!best) stats.typelessVehicles.push(cluster.name)
		return best?.[0] ?? 'UNKNOWN'
	})
	const vehicleTypes = Array.from(new Set(vehicleTypeNames)).sort()
	const vehicleTypeIds = vehicleTypeNames.map((name) => vehicleTypes.indexOf(name))

	const unitRecords = Array.from(unitRecordKeys.keys()).sort()
	const unitRecordVehicles = unitRecords.map((unitName) => {
		const ids = new Set(unitRecordKeys.get(unitName)!.map((key) => clusterIndex.get(clusterOf.get(key)!)!))
		return Array.from(ids).sort((a, b) => a - b)
	})

	stats.canonical = vehicles.length
	return { vehicles, vehicleTypes, vehicleTypeIds, unitRecords, unitRecordVehicles, stats }
}

function refCount(records: VehicleRecord[]): number {
	return records.reduce((sum, record) => sum + record.refs, 0)
}

// the dominant chassis token of the cluster, unless another cluster claims the same one
function distinguishingToken(cluster: VehicleRecord[], others: VehicleRecord[][]): string {
	const dominantChassis = (records: VehicleRecord[]): string => {
		const counts = new Map<string, number>()
		for (const record of records) {
			if (record.chassis === '') continue
			counts.set(record.chassis, (counts.get(record.chassis) ?? 0) + record.refs)
		}
		return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ''
	}
	const chassis = dominantChassis(cluster)
	if (chassis !== '' && !others.some((records) => dominantChassis(records) === chassis)) return chassis
	return cluster[0].vehType !== '' ? cluster[0].vehType.toLowerCase() : 'variant'
}
