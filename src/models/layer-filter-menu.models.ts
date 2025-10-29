import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import * as EFB from '@/models/editable-filter-builders'
import * as FB from '@/models/filter-builders.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as Im from 'immer'
import React from 'react'
import * as Zus from 'zustand'

export type FilterMenuStore = {
	filter?: F.FilterNode
	menuItems: Record<keyof L.KnownLayer | string, F.EditableComparison>
	siblingFilters: { [k in keyof L.KnownLayer | string]: F.FilterNode | undefined }
	baseQueryInput?: LQY.BaseQueryInput
	setMenuItems: React.Dispatch<React.SetStateAction<Record<keyof L.KnownLayer | string, F.EditableComparison>>>
	swapTeams: () => void
	setComparison: (field: keyof L.KnownLayer | string, update: React.SetStateAction<F.EditableComparison>) => void
	resetFilter: (field: keyof L.KnownLayer | string) => void
	resetAllFilters: () => void
}

export function useFilterMenuStore(
	queryInputStore: Zus.StoreApi<{ queryInput: LQY.BaseQueryInput }>,
	defaultFields: Partial<L.KnownLayer> = {},
) {
	const colConfig = ConfigClient.useEffectiveColConfig()
	const defaultFieldsRef = React.useRef(defaultFields)
	const [store, subHandle] = React.useMemo(() => {
		const store = Zus.createStore<FilterMenuStore>((set, get) => {
			if (!colConfig) {
				throw new Error(
					"colConfig is undefined when creating filter menu store. this shouldn't be possible. if it is we need to be smarter about how we use this store to avoid stale references",
				)
			}
			const emptyItems = getDefaultFilterMenuItemState({}, colConfig)
			const defaultItems = getDefaultFilterMenuItemState(defaultFieldsRef.current, colConfig)
			const filter = getFilterFromComparisons(defaultItems)
			const siblingFilters = getSiblingFiltersForMenuItems(defaultItems)

			return {
				menuItems: defaultItems,
				filter,
				siblingFilters: siblingFilters,
				baseQueryInput: queryInputStore.getState().queryInput,

				setMenuItems: (update) => {
					let updated: Record<keyof L.KnownLayer | string, F.EditableComparison>
					const state = get()
					if (typeof update === 'function') {
						updated = update(state.menuItems)
					} else {
						updated = update
					}

					const filter = getFilterFromComparisons(updated)
					const siblingFilters = getSiblingFiltersForMenuItems(updated)

					set({
						menuItems: updated,
						filter,
						siblingFilters,
					})
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
									const parsedLayer = L.parseLayerStringSegment(comp.value as string)
									draft['Layer'].value = comp.value
									if (!parsedLayer) {
										return
									}
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
				},
			}
		})

		const subHandle = ZusUtils.createSubHandle((subs) => {
			subs.push(queryInputStore.subscribe(state => {
				store.setState({
					baseQueryInput: state.queryInput,
				})
			}))
		})

		return [store, subHandle] as const
	}, [colConfig, queryInputStore])

	ZusUtils.useSubHandle(subHandle)

	return store
}

export function selectFilterMenuQueryInput(state: FilterMenuStore): LQY.BaseQueryInput {
	let constraints = state.baseQueryInput?.constraints ?? []
	if (state.filter) {
		constraints = [...constraints, CB.filterAnon('filter-menu', state.filter)]
	}
	return {
		...state.baseQueryInput,
		constraints,
	}
}

export function selectSwapFactionsDisabled(state: FilterMenuStore) {
	const swapFactionsDisabled = !(
		['Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Alliance_1', 'Alliance_2'].some(key =>
			state.menuItems[key as keyof L.KnownLayer].value !== undefined
		)
	)
	return swapFactionsDisabled
}

export function selectFilterMenuItemConstraints(state: FilterMenuStore, field: string): LQY.BaseQueryInput {
	let constraints = state.baseQueryInput?.constraints ?? []
	if (state.siblingFilters[field]) {
		constraints = [
			...constraints,
			CB.filterAnon('sibling-' + field, state.siblingFilters[field]!),
		]
	}
	return { ...state.baseQueryInput, constraints }
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
function getSiblingFiltersForMenuItems(items: Record<keyof L.KnownLayer | string, F.EditableComparison>) {
	const filtersExcludingFields: { [k in keyof L.KnownLayer | string]: F.FilterNode | undefined } = {}

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
