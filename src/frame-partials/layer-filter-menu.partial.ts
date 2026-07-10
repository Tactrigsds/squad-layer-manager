import * as Arr from '@/lib/array'
import type * as FRM from '@/lib/frame'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as EFB from '@/models/editable-filter-builders'
import * as FB from '@/models/filter-builders.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models'
import * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'

export type FilterMenuItemPossibleValues = Record<string, string[]>

export type FilterMenuStore = {
	filter?: F.FilterNode
	// each menu item is a simple comparison locked to its column key
	menuItems: Record<string, F.EditableCompNode>
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
}
type Args = FRM.SetupArgs<Input, Store, Store & Predicates>

// const

export function initLayerFilterMenuStore(
	args: Args,
) {
	const set = ZusUtils.toPartialSetter(args.set, 'filterMenu')
	const defaultItems = getDefaultFilterMenuItemState(args.input.defaultFields ?? {}, args.input.colConfig)
	const filter = getFilterFromComparisons(defaultItems)

	const state: FilterMenuStore = {
		menuItems: defaultItems,
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
		Alliance_2: EFB.eq('Alliance_2', defaultFields['Alliance_1'] ?? undefined),
		Faction_2: EFB.eq('Faction_2', defaultFields['Faction_2']),
		Unit_2: EFB.eq('Unit_2', defaultFields['Unit_2']),
	}

	if (config?.extraLayerSelectMenuItems) {
		for (const item of config.extraLayerSelectMenuItems) {
			const column = F.compAnchorColumn(item)
			if (column) extraItems[column] = item
		}
	}
	return extraItems
}

function getFilterFromComparisons(items: Record<string, F.EditableCompNode>) {
	const nodes: F.FilterNode[] = []
	for (const key in items) {
		const item = items[key]
		if (!F.isValidCompNode(item)) continue
		nodes.push(item)
	}

	if (nodes.length === 0) return undefined
	return FB.all(nodes)
}

export namespace Sel {
	export function filterMenuConstraints(store: Store): LQY.Constraint[] {
		let items: LQY.FilterMenuItem[] = []
		for (const [field, node] of Object.entries(store.filterMenu.menuItems)) {
			const returnPossibleValues = LC.isEnumeratedColumn(field, { ...CS.init(), effectiveColsConfig: store.filterMenu.colConfig })
			let excludedSiblings: string[] | undefined
			if (field === 'Layer') {
				excludedSiblings = [...L.LAYER_STRING_PROPERTIES as string[]]
			} else if (Arr.includes(L.LAYER_STRING_PROPERTIES, field)) {
				excludedSiblings = ['Layer']
			}
			items.push({
				field,
				node: F.isValidCompNode(node) ? node : undefined,
				returnPossibleValues,
				excludedSiblings,
			})
		}
		if (items.length === 0) return []
		return [CB.filterMenuItems('filter-menu', items)]
	}

	export function swapFactionsDisabled(state: Store) {
		const swapFactionsDisabled = !(
			['Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Alliance_1', 'Alliance_2'].some(key =>
				F.compValue(state.filterMenu.menuItems[key]) !== undefined
			)
		)
		return swapFactionsDisabled
	}
}

export namespace Actions {
	export function setMenuItems(stores: KeyProp, update: React.SetStateAction<Record<string, F.EditableCompNode>>) {
		const slice = ZusUtils.toPartialStore(stores.filterMenu, 'filterMenu')
		const updated = typeof update === 'function' ? update(slice.getState().menuItems) : update
		const filter = getFilterFromComparisons(updated)
		slice.setState({ menuItems: updated, filter })
	}

	export function swapTeams(stores: KeyProp) {
		setMenuItems(stores, state =>
			Im.produce(state, draft => {
				const faction1 = F.compValue(draft['Faction_1'])
				const subFac1 = F.compValue(draft['Unit_1'])
				const alliance1 = F.compValue(draft['Alliance_1'])
				F.setCompValue(draft['Faction_1'], F.compValue(draft['Faction_2']))
				F.setCompValue(draft['Unit_1'], F.compValue(draft['Unit_2']))
				F.setCompValue(draft['Alliance_1'], F.compValue(draft['Alliance_2']))
				F.setCompValue(draft['Faction_2'], faction1)
				F.setCompValue(draft['Unit_2'], subFac1)
				F.setCompValue(draft['Alliance_2'], alliance1)
			}))
	}

	export function setComparison(stores: KeyProp, field: string, update: React.SetStateAction<F.EditableCompNode>) {
		setMenuItems(
			stores,
			Im.produce(
				(draft) => {
					const prevComp = draft[field]
					const prevValue = F.compValue(prevComp)
					const comp = typeof update === 'function' ? update(prevComp) : update
					const column = F.compAnchorColumn(comp)
					const value = F.compValue(comp)
					const setFieldValue = (f: string, v: F.Value | undefined) => {
						if (draft[f]) F.setCompValue(draft[f], v)
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
						column === 'Map'
						|| (column === 'Gamemode'
							// keep layer version if switching from RAAS to FRAAS or vice versa TODO test this
							&& !(prevValue?.toString().includes('RAAS') && value?.toString().includes('RAAS')))
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
				},
			),
		)
	}

	export function resetFilter(stores: KeyProp, field: string) {
		const slice = ZusUtils.toPartialStore(stores.filterMenu, 'filterMenu')
		const emptyItems = getDefaultFilterMenuItemState({}, slice.getState().colConfig)
		const emptyComparison = emptyItems[field]
		if (emptyComparison) {
			setComparison(stores, field, emptyComparison)
		}
	}

	export function resetAllFilters(stores: KeyProp) {
		const slice = ZusUtils.toPartialStore(stores.filterMenu, 'filterMenu')
		const emptyItems = getDefaultFilterMenuItemState({}, slice.getState().colConfig)
		Object.entries(emptyItems).forEach(([field, item]) => {
			setComparison(stores, field, item)
		})
		slice.getState().clearAll$.next()
	}
}
