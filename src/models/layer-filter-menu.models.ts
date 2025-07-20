import * as EFB from '@/models/editable-filter-builders'
import * as FB from '@/models/filter-builders.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import React from 'react'
import * as Zus from 'zustand'

export function useFilterMenuStore(defaultFields: Partial<L.KnownLayer> = {}) {
	const store = React.useMemo(() => (
		Zus.createStore<FilterMenuStore>((set, get) => {
			const items = getDefaultFilterMenuItemState(defaultFields)
			const filter = getFilterFromComparisons(items)
			const siblingFilters = getSiblingFiltersForMenuItems(items)

			return {
				menuItems: items,
				filter,
				siblingFilters: siblingFilters,
				setMenuItems: (update) => {
					let updated: Record<keyof L.KnownLayer, F.EditableComparison>
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
			}
		})
	), [])
	return store
}

export function selectFilterMenuConstraints(state: FilterMenuStore) {
	return state.filter ? [LQY.filterToNamedConstrant(state.filter, 'filter-menu', 'Filter Menu')] : []
}

export function getDefaultFilterMenuItemState(defaultFields: Partial<L.KnownLayer>): Record<keyof L.KnownLayer, F.EditableComparison> {
	return {
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
	} as Record<keyof L.KnownLayer, F.EditableComparison>
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

export type FilterMenuStore = {
	filter?: F.FilterNode
	menuItems: Record<keyof L.KnownLayer, F.EditableComparison>
	siblingFilters: { [k in keyof L.KnownLayer]: F.FilterNode | undefined }
	setMenuItems: React.Dispatch<React.SetStateAction<Record<keyof L.KnownLayer, F.EditableComparison>>>
}

/**
 * Derive filter nodes which
 */
function getSiblingFiltersForMenuItems(items: Record<keyof L.KnownLayer, F.EditableComparison>) {
	// @ts-expect-error idc
	const filtersExcludingFields: { [k in keyof L.KnownLayer]: F.FilterNode | undefined } = {}

	for (const itemKey in items) {
		const key = itemKey as keyof L.KnownLayer
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
