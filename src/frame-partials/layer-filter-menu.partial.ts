import type * as FRM from '@/lib/frame'
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
	menuItems: Record<string, F.EditableComparison>
	baseQueryInput?: LQY.BaseQueryInput
	setMenuItems: React.Dispatch<React.SetStateAction<Record<string, F.EditableComparison>>>
	swapTeams: () => void
	setComparison: (field: string, update: React.SetStateAction<F.EditableComparison>) => void
	resetFilter: (field: string) => void
	clearAll$: Rx.Subject<void>
	resetAllFilters: () => void

	colConfig: LC.EffectiveColumnConfig
}

export type Store = {
	filterMenu: FilterMenuStore
}

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
	const emptyItems = getDefaultFilterMenuItemState({}, args.input.colConfig)
	const defaultItems = getDefaultFilterMenuItemState(args.input.defaultFields ?? {}, args.input.colConfig)
	const filter = getFilterFromComparisons(defaultItems)

	const state: FilterMenuStore = {
		menuItems: defaultItems,
		filter,
		baseQueryInput: {},
		colConfig: args.input.colConfig,

		setMenuItems: (update) => {
			let updated: Record<string, F.EditableComparison>
			const state = args.get()
			if (typeof update === 'function') {
				updated = update(state.filterMenu.menuItems)
			} else {
				updated = update
			}

			const filter = getFilterFromComparisons(updated)

			args.set(state => ({
				filterMenu: {
					...state.filterMenu,
					menuItems: updated,
					filter,
				},
			}))
		},
		swapTeams() {
			this.setMenuItems(state =>
				Im.produce(state, draft => {
					const faction1 = draft['Faction_1'].value
					const subFac1 = draft['Unit_1'].value
					const alliance1 = draft['Alliance_1'].value
					draft['Faction_1'].value = draft['Faction_2'].value
					draft['Unit_1'].value = draft['Unit_2'].value
					draft['Alliance_1'].value = draft['Alliance_2'].value
					draft['Faction_2'].value = faction1
					draft['Unit_2'].value = subFac1
					draft['Alliance_2'].value = alliance1
				})
			)
		},
		setComparison(field, update) {
			this.setMenuItems(
				// TODO having this be inline is kinda gross
				Im.produce(
					(draft) => {
						const prevComp = draft[field]
						const comp = typeof update === 'function' ? update(prevComp) : update

						if (comp.column === 'Layer' && comp.value) {
							// TODO this section doesn't handle training modes well
							let parsedLayer = L.parseLayerStringSegment(comp.value as string)
							draft['Layer'].value = comp.value
							if (!parsedLayer) {
								return
							}
							parsedLayer = L.applyBackwardsCompatMappings(parsedLayer)
							draft['Map'].value = parsedLayer.Map
							draft['Gamemode'].value = parsedLayer.Gamemode
							draft['LayerVersion'].value = parsedLayer.LayerVersion
						} else if (comp.column === 'Layer' && !comp.value) {
							delete draft['Layer'].value
							delete draft['Map'].value
							delete draft['Gamemode'].value
							delete draft['LayerVersion'].value
						} else if (comp !== undefined) {
							draft[field] = comp
						}

						if (
							comp.column === 'Map'
							|| comp.column === 'Gamemode'
								// keep layer version if switching from RAAS to FRAAS or vice versa TODO test this
								&& !(prevComp.value?.toString().includes('RAAS') && comp.value?.toString().includes('RAAS'))
						) {
							delete draft['LayerVersion'].value
						}

						if ((L.LAYER_STRING_PROPERTIES as string[]).includes(comp.column as string) && comp.value) {
							const excludingCurrent = L.LAYER_STRING_PROPERTIES.filter((p) => p !== comp.column)
							if (excludingCurrent.every((p) => draft[p as string]?.value)) {
								const args = {
									Gamemode: draft['Gamemode'].value!,
									Map: draft['Map'].value!,
									LayerVersion: draft['LayerVersion'].value!,
								} as Parameters<typeof L.getLayerString>[0]
								// @ts-expect-error idc
								args[comp.column] = comp.value!
								draft['Layer'].value = L.getLayerString(args)
							} else {
								delete draft['Layer'].value
							}
						}
					},
				),
			)
		},
		resetFilter(field) {
			const emptyComparison = emptyItems[field]
			if (emptyComparison) {
				this.setComparison(field, emptyComparison)
			}
		},
		resetAllFilters() {
			Object.entries(emptyItems).forEach(([field, item]) => {
				this.setComparison(field, item)
			})
			this.clearAll$.next()
		},
		clearAll$: new Rx.Subject<void>(),
	}

	args.set({ filterMenu: state })
}

export function getDefaultFilterMenuItemState(
	defaultFields: Partial<L.KnownLayer>,
	config?: LQY.EffectiveColumnAndTableConfig,
): Record<string, F.EditableComparison> {
	const extraItems: Record<string, F.EditableComparison> = {
		Size: EFB.eq('Size', defaultFields['Size'] ?? undefined),
		Layer: EFB.eq('Layer', defaultFields['Layer']),
		Map: EFB.eq('Map', defaultFields['Map']),
		Gamemode: EFB.eq('Gamemode', defaultFields['Gamemode']),
		LayerVersion: EFB.eq('LayerVersion', defaultFields['LayerVersion'] ?? undefined),
		Alliance_1: EFB.eq('Alliance_1', defaultFields['Alliance_1'] ?? undefined),
		Faction_1: EFB.eq('Faction_1', defaultFields['Faction_1']),
		Unit_1: EFB.eq('Unit_1', defaultFields['Unit_1']),
		Alliance_2: EFB.eq('Alliance_2', defaultFields['Alliance_1'] ?? undefined),
		Faction_2: EFB.eq('Faction_2', defaultFields['Faction_2']),
		Unit_2: EFB.eq('Unit_2', defaultFields['Unit_2']),
	}

	if (config?.extraLayerSelectMenuItems) {
		for (const obj of config.extraLayerSelectMenuItems) {
			extraItems[obj.column!] = obj
		}
	}
	return extraItems
}

function getFilterFromComparisons(items: Record<keyof L.KnownLayer, F.EditableComparison>) {
	const nodes: F.FilterNode[] = []
	for (const key in items) {
		const item = items[key as keyof L.KnownLayer]
		if (!F.isValidComparison(item)) continue
		nodes.push(FB.comp(item))
	}

	if (nodes.length === 0) return undefined
	return FB.and(nodes)
}

export function selectFilterMenuConstraints(store: Store): LQY.Constraint[] {
	let items: LQY.FilterMenuItem[] = []
	for (const [field, node] of Object.entries(store.filterMenu.menuItems)) {
		const returnPossibleValues = LC.isEnumeratedColumn(field, { ...CS.init(), effectiveColsConfig: store.filterMenu.colConfig })
		let excludedSiblings: string[] | undefined
		const compositeLayerFields = ['Map', 'Gamemode', 'LayerVersion']
		if (field === 'Layer') {
			excludedSiblings = compositeLayerFields
		} else if (compositeLayerFields.includes(field)) {
			excludedSiblings = ['Layer']
		}
		items.push({
			field,
			node: F.isValidComparison(node) ? FB.comp(node) : undefined,
			returnPossibleValues,
			excludedSiblings,
		})
	}
	if (items.length === 0) return []
	return [CB.filterMenuItems('filter-menu', items)]
}

export function selectSwapFactionsDisabled(state: Store) {
	const swapFactionsDisabled = !(
		['Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Alliance_1', 'Alliance_2'].some(key =>
			state.filterMenu.menuItems[key as keyof L.KnownLayer].value !== undefined
		)
	)
	return swapFactionsDisabled
}
