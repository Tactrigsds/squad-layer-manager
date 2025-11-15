import * as FRM from '@/lib/frame'
import * as CB from '@/models/constraint-builders'
import * as EFB from '@/models/editable-filter-builders'
import * as FB from '@/models/filter-builders.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'

export type FilterMenuStore = {
	filter?: F.FilterNode
	menuItems: Record<keyof L.KnownLayer | string, F.EditableComparison>
	siblingFilters: { [k in keyof L.KnownLayer | string]: F.FilterNode | undefined }
	baseQueryInput?: LQY.BaseQueryInput
	setMenuItems: React.Dispatch<React.SetStateAction<Record<keyof L.KnownLayer | string, F.EditableComparison>>>
	swapTeams: () => void
	setComparison: (field: keyof L.KnownLayer | string, update: React.SetStateAction<F.EditableComparison>) => void
	resetFilter: (field: keyof L.KnownLayer | string) => void
	clearAll$: Rx.Subject<void>
	resetAllFilters: () => void
}

export type Store = {
	filterMenu: FilterMenuStore
}

type Input = {
	colConfig: LQY.EffectiveColumnAndTableConfig
	defaultFields?: Partial<L.KnownLayer>
}
type Args = FRM.SetupArgs<Input, Store, Store>

export function initLayerFilterMenuStore(
	args: Args,
) {
	const emptyItems = getDefaultFilterMenuItemState({}, args.input.colConfig)
	const defaultItems = getDefaultFilterMenuItemState(args.input.defaultFields ?? {}, args.input.colConfig)
	const filter = getFilterFromComparisons(defaultItems)
	const siblingFilters = getSiblingFiltersForMenuItems(defaultItems)

	const state: FilterMenuStore = {
		menuItems: defaultItems,
		filter,
		siblingFilters: siblingFilters,
		baseQueryInput: {},

		setMenuItems: (update) => {
			let updated: Record<keyof L.KnownLayer | string, F.EditableComparison>
			const state = args.get()
			if (typeof update === 'function') {
				updated = update(state.filterMenu.menuItems)
			} else {
				updated = update
			}

			const filter = getFilterFromComparisons(updated)
			const siblingFilters = getSiblingFiltersForMenuItems(updated)

			args.set(state => ({
				filterMenu: {
					...state.filterMenu,
					menuItems: updated,
					filter,
					siblingFilters,
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

						if (comp.column === 'Map' || comp.column === 'Gamemode') {
							delete draft['LayerVersion'].value
						}

						if ((L.LAYER_STRING_PROPERTIES as string[]).includes(comp.column as string) && comp.value) {
							const excludingCurrent = L.LAYER_STRING_PROPERTIES.filter((p) => p !== comp.column)
							if (excludingCurrent.every((p) => draft[p as keyof L.KnownLayer | string]?.value)) {
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
): Record<keyof L.KnownLayer | string, F.EditableComparison> {
	const extraItems: Record<string | keyof L.KnownLayer, F.EditableComparison> = {
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

/**
 * Derive filter nodes which
 */
function getSiblingFiltersForMenuItems(items: Record<string, F.EditableComparison>) {
	const filtersExcludingFields: { [k in keyof string]: F.FilterNode | undefined } = {}

	for (const key in items) {
		const item = items[key]
		if (!item.column) continue

		const comparisonsToApply: F.FilterNode[] = []
		for (const candKey in items) {
			if (key === candKey) continue
			const cand = items[candKey as keyof L.KnownLayer]
			if (!F.isValidComparison(cand)) continue

			// don't filter out the composite columns based on the filter with a combined value, because that would be annoying
			if (item.column === 'Layer' && ['Map', 'Gamemode', 'LayerVersion'].includes(cand.column)) continue
			if (['Map', 'Gamemode', 'LayerVersion'].includes(item.column) && cand.column === 'Layer') continue
			comparisonsToApply.push(FB.comp(cand))
		}

		if (filtersExcludingFields[key]) {
			console.warn('unexpected duplicate detected when deriving sibling filters', items)
		}
		filtersExcludingFields[key] = comparisonsToApply.length > 0 ? FB.and(comparisonsToApply) : undefined
	}

	return filtersExcludingFields
}

export function selectFilterMenuConstraints(store: Store): LQY.Constraint[] {
	const menu = store.filterMenu
	if (menu.filter) {
		return [CB.filterAnon('filter-menu', menu.filter)]
	}
	return []
}

export function selectSwapFactionsDisabled(state: Store) {
	const swapFactionsDisabled = !(
		['Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Alliance_1', 'Alliance_2'].some(key =>
			state.filterMenu.menuItems[key as keyof L.KnownLayer].value !== undefined
		)
	)
	return swapFactionsDisabled
}

// extra constraint for filter menu items
export function selectFilterMenuItemConstraints(state: Store, field: string): LQY.Constraint[] {
	let constraints: LQY.Constraint[] = []
	if (state.filterMenu.siblingFilters[field]) {
		constraints = [
			CB.filterAnon('sibling-' + field, state.filterMenu.siblingFilters[field]!),
		]
	}
	return constraints
}
