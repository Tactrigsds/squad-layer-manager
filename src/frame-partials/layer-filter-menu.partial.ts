import * as Im from 'immer'
import React from 'react'

import * as Arr from '@/lib/array-utils'
import type * as FRM from '@/lib/frame'
import * as RSel from '@/lib/reselect'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as EFB from '@/models/editable-filter-builders'
import * as FB from '@/models/filter-builders.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models'

export type FilterMenuItemPossibleValues = Record<string, string[]>

export type FilterMenuStore = {
	filter?: F.FilterNode
	// each menu item is a simple comparison locked to its column key
	menuItems: Record<string, F.EditableCompNode>
	// what resetFilter/resetAllFilters restore each item to (valueless comps, one per field)
	emptyItems: Record<string, F.EditableCompNode>
	baseQueryInput?: LQY.BaseQueryInput
	clearAll$: Rx.Subject<void>

	colConfig: LQY.EffectiveColumnAndTableConfig
}

export type Store = {
	filterMenu: FilterMenuStore
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { filterMenu: Key }
// for consumers that also read the host frame's Predicates (e.g. filterMenuItemPossibleValues)
export type PredicatedKey = FRM.InstanceKeyOfState<Store & Predicates>
export type PredicatedKeyProp = { filterMenu: PredicatedKey }

export type Predicates = {
	filterMenuItemPossibleValues?: FilterMenuItemPossibleValues
	resetAllConstraints: () => void
}

type Input = {
	colConfig: LQY.EffectiveColumnAndTableConfig
	defaultFields?: Partial<L.KnownLayer>
	// custom menu item set (field -> comparison), for hosts that don't want the full layer-select menu.
	// `emptyItems` should be the valueless counterparts; defaults to `items` as given.
	items?: Record<string, F.EditableCompNode>
	emptyItems?: Record<string, F.EditableCompNode>
}
type Args = FRM.SetupArgs<Input, Store, Store & Predicates>

// const

export function initLayerFilterMenuStore(args: Args) {
	const set = Zus.toPartialSetter(args.set, 'filterMenu')
	const defaultItems = args.input.items ?? getDefaultFilterMenuItemState(args.input.defaultFields ?? {}, args.input.colConfig)
	const emptyItems =
		args.input.emptyItems ?? (args.input.items ? args.input.items : getDefaultFilterMenuItemState({}, args.input.colConfig))
	const filter = getFilterFromComparisons(defaultItems)

	const state: FilterMenuStore = {
		menuItems: defaultItems,
		emptyItems,
		filter,
		baseQueryInput: {},
		colConfig: args.input.colConfig,
		clearAll$: new Rx.Subject<void>(),
	}

	set(state)
}

export function getDefaultFilterMenuItemState(
	defaultFields: Partial<L.KnownLayer>,
	config?: LQY.EffectiveColumnAndTableConfig,
): Record<string, F.EditableCompNode> {
	const extraItems: Record<string, F.EditableCompNode> = {
		Size: EFB.eq('Size', defaultFields['Size'] ?? undefined),
		Layer: EFB.eq('Layer', defaultFields['Layer']),
		Map: EFB.eq('Map', defaultFields['Map']),
		Gamemode: EFB.eq('Gamemode', defaultFields['Gamemode']),
		LayerVersion: EFB.eq('LayerVersion', defaultFields['LayerVersion'] ?? undefined),
		Collection: EFB.eq('Collection', defaultFields['Collection'] ?? undefined),
		Alliance_1: EFB.eq('Alliance_1', defaultFields['Alliance_1'] ?? undefined),
		Faction_1: EFB.eq('Faction_1', defaultFields['Faction_1']),
		Unit_1: EFB.eq('Unit_1', defaultFields['Unit_1']),
		Alliance_2: EFB.eq('Alliance_2', defaultFields['Alliance_2'] ?? undefined),
		Faction_2: EFB.eq('Faction_2', defaultFields['Faction_2']),
		Unit_2: EFB.eq('Unit_2', defaultFields['Unit_2']),
		// virtual columns, so they take no default from a layer: a layer names its units, not their vehicles
		Vehicle_1: EFB.eq('Vehicle_1'),
		VehicleType_1: EFB.eq('VehicleType_1'),
		Vehicle_2: EFB.eq('Vehicle_2'),
		VehicleType_2: EFB.eq('VehicleType_2'),
	}

	if (config?.extraLayerSelectMenuItems) {
		for (const item of config.extraLayerSelectMenuItems) {
			const column = F.compAnchorColumn(item)
			if (column) extraItems[column] = item
		}
	}
	return extraItems
}

// A matchup row shows one operator for both sides, and swapTeams moves values between them, so a row seeded with
// an `in` on one side and an `eq` on the other has both widened to `in`
export function alignTeamRowOperators(items: Record<string, F.EditableCompNode>): Record<string, F.EditableCompNode> {
	const next = { ...items }
	for (const [field1, field2] of teamFieldPairs()) {
		const comp1 = items[field1]
		const comp2 = items[field2]
		if (!comp1 || !comp2 || comp1.type === comp2.type) continue
		if (comp1.type === 'in') next[field2] = F.applyCompOpSelection(comp2, comp1)
		else if (comp2.type === 'in') next[field1] = F.applyCompOpSelection(comp1, comp2)
	}
	return next
}

function teamFieldPairs(): [team1: string, team2: string][] {
	return F.TEAM_COLUMNS.map((column) => [F.resolveTeamColumn(column, 1), F.resolveTeamColumn(column, 2)])
}

// a menu item's selection, whatever shape its comparison has: `in` items carry a list, the rest a single value
function itemValues(comp: F.EditableCompNode): F.Value[] | undefined {
	const values = F.compValues(comp)
	if (values) return values.filter((item): item is F.Value => !F.isColumnListItem(item))
	const value = F.compValue(comp)
	return value === undefined ? undefined : [value]
}

// a values-shaped comp (in) must stay values-shaped, or the node ends up with a value-arg its code can't read
function setItemValues(comp: F.EditableCompNode, values: F.Value[] | undefined) {
	const valuesArg = comp.args.find((arg): arg is F.EditableValuesArg => arg?.type === 'values')
	if (valuesArg) valuesArg.values = values?.length ? values : undefined
	else F.setCompValue(comp, values?.[0])
}

// Most menu items are empty, and a failed safeParse builds a ZodError with a stack. Only an `in` with an empty list
// can be valid without a value.
function isValidMenuItem(node: F.EditableCompNode): node is F.CompNode {
	return (node.type === 'in' || F.editableCompHasValue(node)) && F.isValidCompNode(node)
}

function getFilterFromComparisons(items: Record<string, F.EditableCompNode>) {
	const nodes: F.FilterNode[] = []
	for (const key in items) {
		const item = items[key]
		if (!isValidMenuItem(item)) continue
		nodes.push(item)
	}

	if (nodes.length === 0) return undefined
	return FB.and(nodes)
}

export namespace Sel {
	export const filterMenuConstraints = RSel.createSelector(
		[(store: Store) => store.filterMenu.menuItems, (store: Store) => store.filterMenu.colConfig],
		(menuItems, colConfig): LQY.Constraint[] => {
			const items: LQY.FilterMenuItem[] = []
			const ctx = { ...CS.init(), effectiveColsConfig: colConfig }
			for (const [field, node] of Object.entries(menuItems)) {
				// a virtual column has no artifact column to take a distinct over, so its editor offers the whole enum
				const returnPossibleValues = LC.isEnumeratedColumn(field, ctx) && !LC.isVirtualColumn(field, colConfig)
				let excludedSiblings: string[] | undefined
				if (field === 'Layer') {
					excludedSiblings = [...(L.LAYER_STRING_PROPERTIES as string[])]
				} else if (Arr.includes(L.LAYER_STRING_PROPERTIES, field)) {
					excludedSiblings = ['Layer']
				}
				items.push({
					field,
					node: isValidMenuItem(node) ? node : undefined,
					returnPossibleValues,
					excludedSiblings,
				})
			}
			if (items.length === 0) return []
			return [CB.filterMenuItems('filter-menu', items)]
		},
	)

	export function swapFactionsDisabled(state: Store) {
		return !teamFieldPairs().some(([field1, field2]) =>
			[field1, field2].some((field) => {
				const comp = state.filterMenu.menuItems[field]
				return comp && F.editableCompHasValue(comp)
			}),
		)
	}
}

export namespace Actions {
	export function setMenuItems(stores: KeyProp, update: React.SetStateAction<Record<string, F.EditableCompNode>>) {
		const slice = Zus.toPartialStore(stores.filterMenu, 'filterMenu')
		const updated = typeof update === 'function' ? update(slice.getState().menuItems) : update
		const filter = getFilterFromComparisons(updated)
		slice.setState({ menuItems: updated, filter })
	}

	export function swapTeams(stores: KeyProp) {
		setMenuItems(stores, (state) =>
			Im.produce(state, (draft) => {
				for (const [field1, field2] of teamFieldPairs()) {
					if (!draft[field1] || !draft[field2]) continue
					const values1 = itemValues(draft[field1])
					setItemValues(draft[field1], itemValues(draft[field2]))
					setItemValues(draft[field2], values1)
				}
			}),
		)
	}

	// one operator governs both sides of a matchup row
	export function setTeamRowOperator(stores: KeyProp, fields: readonly string[], option: Pick<F.CompOpSelectOption, 'type' | 'neg'>) {
		setMenuItems(stores, (items) => {
			const next = { ...items }
			for (const field of fields) {
				if (items[field]) next[field] = F.applyCompOpSelection(items[field], option)
			}
			return next
		})
	}

	export function setComparison(stores: KeyProp, field: string, update: React.SetStateAction<F.EditableCompNode>) {
		setMenuItems(
			stores,
			Im.produce((draft) => {
				const prevComp = draft[field]
				const prevValue = F.compValue(prevComp)
				const comp = typeof update === 'function' ? update(prevComp) : update
				const column = F.compAnchorColumn(comp)
				const value = F.compValue(comp)
				const setFieldValue = (f: string, v: F.Value | undefined) => {
					const fieldComp = draft[f]
					if (fieldComp) setItemValues(fieldComp, v === undefined ? undefined : [v])
				}

				if (column === 'Layer' && value) {
					// TODO this section doesn't handle training modes well
					let parsedLayer = L.parseLayerStringSegment(value as string)
					setFieldValue('Layer', value)
					if (!parsedLayer) {
						return
					}
					parsedLayer = L.applyBackwardsCompatMappings(parsedLayer)
					setFieldValue('Map', parsedLayer.Map)
					setFieldValue('Gamemode', parsedLayer.Gamemode)
					setFieldValue('LayerVersion', parsedLayer.LayerVersion)
					setFieldValue('Collection', parsedLayer.Collection)
				} else if (column === 'Layer' && !value) {
					setFieldValue('Layer', undefined)
					setFieldValue('Map', undefined)
					setFieldValue('Gamemode', undefined)
					setFieldValue('LayerVersion', undefined)
					setFieldValue('Collection', undefined)
				} else {
					draft[field] = comp
				}

				if (
					column === 'Map' ||
					(column === 'Gamemode' &&
						// keep layer version if switching from RAAS to FRAAS or vice versa TODO test this
						!(prevValue?.toString().includes('RAAS') && value?.toString().includes('RAAS')))
				) {
					setFieldValue('LayerVersion', undefined)
				}

				if ((L.LAYER_STRING_PROPERTIES as string[]).includes(column as string) && value) {
					const excludingCurrent = L.LAYER_STRING_PROPERTIES.filter((p) => p !== column)
					if (excludingCurrent.every((p) => F.compValue(draft[p as string]) !== undefined)) {
						const args = {
							Gamemode: F.compValue(draft['Gamemode'])!,
							Map: F.compValue(draft['Map'])!,
							LayerVersion: F.compValue(draft['LayerVersion'])!,
						} as Parameters<typeof L.getLayerString>[0]
						// @ts-expect-error idc
						args[column] = value!
						setFieldValue('Layer', L.getLayerString(args))
					} else {
						setFieldValue('Layer', undefined)
					}
				}
			}),
		)
	}

	export function resetFilter(stores: KeyProp, field: string) {
		const slice = Zus.toPartialStore(stores.filterMenu, 'filterMenu')
		const emptyComparison = slice.getState().emptyItems[field]
		if (emptyComparison) {
			setComparison(stores, field, emptyComparison)
		}
	}

	export function resetAllFilters(stores: KeyProp) {
		const slice = Zus.toPartialStore(stores.filterMenu, 'filterMenu')
		Object.entries(slice.getState().emptyItems).forEach(([field, item]) => {
			setComparison(stores, field, item)
		})
		slice.getState().clearAll$.next()
	}
}
