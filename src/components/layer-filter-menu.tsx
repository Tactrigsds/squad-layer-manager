import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import * as EFB from '@/lib/editable-filter-builders'
import * as FB from '@/lib/filter-builders.ts'
import { selectProps } from '@/lib/object.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import { GlobalSettingsStore } from '@/systems.client/global-settings'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import ExtraFiltersPanel from './extra-filters-panel'
import { Comparison } from './filter-card'

function getDefaultFilterMenuItemState(defaultFields: Partial<M.MiniLayer>): Record<keyof M.MiniLayer, M.EditableComparison> {
	return {
		Layer: EFB.eq('Layer', defaultFields['Layer']),
		Map: EFB.eq('Map', defaultFields['Map']),
		Gamemode: EFB.eq('Gamemode', defaultFields['Gamemode']),
		LayerVersion: EFB.eq('LayerVersion', defaultFields['LayerVersion']),
		Faction_1: EFB.eq('Faction_1', defaultFields['Faction_1']),
		SubFac_1: EFB.eq('SubFac_1', defaultFields['SubFac_1']),
		Faction_2: EFB.eq('Faction_2', defaultFields['Faction_2']),
		SubFac_2: EFB.eq('SubFac_2', defaultFields['SubFac_2']),
	} as Record<keyof M.MiniLayer, M.EditableComparison>
}

function getFilterFromComparisons(items: Record<keyof M.MiniLayer, M.EditableComparison>) {
	const nodes: M.FilterNode[] = []
	for (const key in items) {
		const item = items[key as keyof M.MiniLayer]
		if (!M.isValidComparison(item)) continue
		nodes.push(FB.comp(item))
	}

	if (nodes.length === 0) return undefined
	return FB.and(nodes)
}

type FilterMenuStore = {
	filter?: M.FilterNode
	menuItems: Record<keyof M.MiniLayer, M.EditableComparison>
	siblingFilters: { [k in keyof M.MiniLayer]: M.FilterNode | undefined }
	setMenuItems: React.Dispatch<React.SetStateAction<Record<keyof M.MiniLayer, M.EditableComparison>>>
}

/**
 * Derive filter nodes which
 */
function getSiblingFiltersForMenuItems(items: Record<keyof M.MiniLayer, M.EditableComparison>) {
	// @ts-expect-error idc
	const filtersExcludingFields: { [k in keyof M.MiniLayer]: M.FilterNode | undefined } = {}

	for (const itemKey in items) {
		const key = itemKey as keyof M.MiniLayer
		const item = items[key]
		if (!item.column) continue

		const comparisonsToApply: M.FilterNode[] = []
		for (const candKey in items) {
			if (key === candKey) continue
			const cand = items[candKey as keyof M.MiniLayer]
			if (!M.isValidComparison(cand)) continue

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

export function useFilterMenuStore(defaultFields: Partial<M.MiniLayer> = {}) {
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
					let updated: Record<keyof M.MiniLayer, M.EditableComparison>
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

export function useQueryContextWithMenuFilter(queryContext: M.LayerQueryContext, store: Zus.StoreApi<FilterMenuStore>) {
	const filter = Zus.useStore(store, s => s.filter)
	if (filter) {
		return {
			...queryContext,
			constraints: [...(queryContext.constraints ?? []), M.filterToNamedConstrant(filter, 'filter-menu', 'Filter Menu')],
		}
	} else {
		return queryContext
	}
}

export default function LayerFilterMenu(props: { filterMenuStore: Zus.StoreApi<FilterMenuStore>; queryContext: M.LayerQueryContext }) {
	const storeState = ZusUtils.useStoreDeep(
		props.filterMenuStore,
		state => selectProps(state, ['menuItems', 'siblingFilters']),
	)
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, s => s.displayTeamsNormalized)

	function applySetFilterFieldComparison(name: keyof M.MiniLayer): React.Dispatch<React.SetStateAction<M.EditableComparison>> {
		return (update) => {
			props.filterMenuStore.getState().setMenuItems(
				// TODO having this be inline is kinda gross
				Im.produce((draft) => {
					const prevComp = draft[name]
					const comp = typeof update === 'function' ? update(prevComp) : update

					if (comp.column === 'Layer' && comp.value) {
						const parsedLayer = M.parseLayerStringSegment(comp.value as string)
						draft['Layer'].value = comp.value
						if (!parsedLayer) {
							return
						}
						draft['Map'].value = parsedLayer.map
						draft['Gamemode'].value = parsedLayer.gamemode
						draft['LayerVersion'].value = parsedLayer.version
					} else if (comp.column === 'Layer' && !comp.value) {
						delete draft['Layer'].value
						delete draft['Map'].value
						delete draft['Gamemode'].value
						delete draft['LayerVersion'].value
					} else if (comp !== undefined) {
						draft[name] = comp
					}

					if (comp.column === 'Map' || comp.column === 'Gamemode') {
						delete draft['LayerVersion'].value
					}

					if ((M.LAYER_STRING_PROPERTIES as string[]).includes(comp.column as string) && comp.value) {
						const excludingCurrent = M.LAYER_STRING_PROPERTIES.filter((p) => p !== comp.column)
						if (excludingCurrent.every((p) => draft[p as keyof M.MiniLayer]?.value)) {
							const args = {
								Gamemode: draft['Gamemode'].value!,
								Map: draft['Map'].value!,
								LayerVersion: draft['LayerVersion'].value!,
							} as Parameters<typeof M.getLayerString>[0]
							// @ts-expect-error idc
							args[comp.column] = comp.value!
							draft['Layer'].value = M.getLayerString(args)
						} else {
							delete draft['Layer'].value
						}
					}
				}),
			)
		}
	}

	function swapFactions() {
		props.filterMenuStore.getState().setMenuItems(
			Im.produce((draft) => {
				const faction1 = draft['Faction_1'].value
				const subFac1 = draft['SubFac_1'].value
				draft['Faction_1'].value = draft['Faction_2'].value
				draft['SubFac_1'].value = draft['SubFac_2'].value
				draft['Faction_2'].value = faction1
				draft['SubFac_2'].value = subFac1
			}),
		)
	}

	return (
		<div className="flex flex-col space-y-2">
			<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
				{Object.entries(storeState.menuItems).map(([key, comparison]) => {
					const name = key as keyof M.MiniLayer
					const setComp = applySetFilterFieldComparison(name)
					function clear() {
						setComp(
							Im.produce((prev) => {
								delete prev.value
							}),
						)
						// @ts-expect-error idgaf
						if (M.LAYER_STRING_PROPERTIES.includes(name)) {
							props.filterMenuStore.getState().setMenuItems(
								Im.produce((draft) => {
									delete draft['Layer'].value
								}),
							)
						}
					}

					const swapFactionsDisabled = !(
						(storeState.menuItems['Faction_1'].value !== undefined || storeState.menuItems['SubFac_1'].value !== undefined)
						|| (storeState.menuItems['Faction_2'].value !== undefined || storeState.menuItems['SubFac_2'].value !== undefined)
					)

					let constraints = props.queryContext.constraints ?? []
					if (storeState.siblingFilters[name]) {
						constraints = [
							...constraints,
							M.filterToConstraint(storeState.siblingFilters[name], 'sibling-' + name),
						]
					}

					let customColumnLabel: string | undefined
					// if (displayTeamsNormalized) {
					//   if (M.getTeamNormalizedUnitProp('A')) { }
					// }

					return (
						<React.Fragment key={name}>
							{(name === 'Map' || name === 'Faction_1') && <Separator className="col-span-4 my-2" />}
							{name === 'Faction_2' && (
								<>
									<Button title="Swap Factions" disabled={swapFactionsDisabled} onClick={swapFactions} size="icon" variant="outline">
										<Icons.FlipVertical2 />
									</Button>
									<span />
									<span />
									<span />
								</>
							)}
							<Comparison
								columnEditable={false}
								highlight={M.editableComparisonHasValue(comparison)}
								comp={comparison}
								setComp={setComp}
								layerQueryContext={{ ...props.queryContext, constraints }}
							/>
							<Button disabled={comparison.value === undefined} variant="ghost" size="icon" onClick={clear}>
								<Icons.Trash />
							</Button>
						</React.Fragment>
					)
				})}
			</div>
			<div>
				<Button variant="secondary" onClick={() => props.filterMenuStore.getState().setMenuItems(getDefaultFilterMenuItemState({}))}>
					Clear All
				</Button>
			</div>
			<ExtraFiltersPanel />
		</div>
	)
}
