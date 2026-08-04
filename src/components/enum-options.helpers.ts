import type { ComboBoxGroupingDef } from '@/components/combo-box/options.ts'
import * as LC_Msgs from '@/messages/layer-columns.messages'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import { tr } from '@/systems/messages.client'

// The dimensions a column's value picker can narrow by, and which group each value sits in. Shared so the
// filter card, the generation editor and the pool panels group the same column the same way.

export const COLLECTION_GROUPING = 'collection'
export const VEHICLE_TYPE_GROUPING = 'vehicleType'

const vehicleTypeGroupsCache = new WeakMap<object, ComboBoxGroupingDef['groups']>()

// Vehicle classes read as their names rather than their codes, which is the difference between scanning a
// list for "Tracked IFV" and for IFV_TRACKED. The code stays searchable: it is the group key, and the drill-in
// matches on both.
function vehicleTypeGroups(components: typeof L.StaticLayerComponents): ComboBoxGroupingDef['groups'] {
	const cached = vehicleTypeGroupsCache.get(components)
	if (cached) return cached
	const groups = (components.vehicleTypes ?? []).map((type) => {
		const label = LC_Msgs.vehicleTypeLabels[type]
		// never a prefix: this grouping never leads, and a class badge on every row would crowd out the name
		return { key: type, label: label ? tr.text(label) : type, prefix: null }
	})
	vehicleTypeGroupsCache.set(components, groups)
	return groups
}

const groupingsCache = new WeakMap<object, Map<string, ComboBoxGroupingDef[]>>()

// Collection always leads: it is the dimension that orders and prefixes the list, and it applies to every
// column a mod can add values to. A vehicle picker gains its class as a second dimension, because the two
// together are the question being asked -- "a tracked IFV from Galactic Contention" is otherwise two passes
// over a list of 483.
//
// Memoized on the components object: these are passed as props, and a fresh array each render would rebuild
// every option list.
export function enumGroupings(column: LC.EnumColumn, components = L.StaticLayerComponents): ComboBoxGroupingDef[] {
	let byColumn = groupingsCache.get(components)
	if (!byColumn) groupingsCache.set(components, (byColumn = new Map()))
	const cached = byColumn.get(column)
	if (cached) return cached

	const groupings: ComboBoxGroupingDef[] = [
		{ key: COLLECTION_GROUPING, label: tr.text(LC_Msgs.collectionGrouping()), groups: LC.collectionGroups(components) },
	]
	if (LC.vehicleColumnInfo(column)?.kind === 'vehicles') {
		groupings.push({
			key: VEHICLE_TYPE_GROUPING,
			label: tr.text(LC_Msgs.vehicleTypeGrouping()),
			groups: vehicleTypeGroups(components),
		})
	}
	byColumn.set(column, groupings)
	return groupings
}

export function enumOptionGroups(
	column: LC.EnumColumn,
	value: string | null,
	components = L.StaticLayerComponents,
): Record<string, string> | undefined {
	const groups: Record<string, string> = {}
	const collection = LC.collectionForEnumValue(column, value, components)
	if (collection) groups[COLLECTION_GROUPING] = collection
	if (value !== null && LC.vehicleColumnInfo(column)?.kind === 'vehicles') {
		const type = LC.vehicleTypeForVehicle(value, components)
		if (type) groups[VEHICLE_TYPE_GROUPING] = type
	}
	return Object.keys(groups).length > 0 ? groups : undefined
}
