import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { selectProps } from '@/lib/object.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LFM from '@/models/layer-filter-menu.models'
import * as LQY from '@/models/layer-queries.models'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import ExtraFiltersPanel from './extra-filters-panel'
import { Comparison } from './filter-card'

export default function LayerFilterMenu(
	props: { filterMenuStore: Zus.StoreApi<LFM.FilterMenuStore>; queryContext: LQY.LayerQueryBaseInput },
) {
	const storeState = ZusUtils.useStoreDeep(
		props.filterMenuStore,
		state => selectProps(state, ['menuItems', 'siblingFilters']),
	)

	function applySetFilterFieldComparison(name: keyof L.KnownLayer): React.Dispatch<React.SetStateAction<F.EditableComparison>> {
		return (update) => {
			props.filterMenuStore.getState().setMenuItems(
				// TODO having this be inline is kinda gross
				Im.produce((draft) => {
					const prevComp = draft[name]
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
						draft[name] = comp
					}

					if (comp.column === 'Map' || comp.column === 'Gamemode') {
						delete draft['LayerVersion'].value
					}

					if ((L.LAYER_STRING_PROPERTIES as string[]).includes(comp.column as string) && comp.value) {
						const excludingCurrent = L.LAYER_STRING_PROPERTIES.filter((p) => p !== comp.column)
						if (excludingCurrent.every((p) => draft[p as keyof L.KnownLayer]?.value)) {
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
				}),
			)
		}
	}

	function swapFactions() {
		props.filterMenuStore.getState().setMenuItems(
			Im.produce((draft) => {
				const faction1 = draft['Faction_1'].value
				const subFac1 = draft['Unit_1'].value
				const alliance1 = draft['Alliance_1'].value
				draft['Faction_1'].value = draft['Faction_2'].value
				draft['Unit_1'].value = draft['Unit_2'].value
				draft['Alliance_1'].value = draft['Alliance_2'].value
				draft['Faction_2'].value = faction1
				draft['Unit_2'].value = subFac1
				draft['Alliance_2'].value = alliance1
			}),
		)
	}

	return (
		<div className="flex flex-col space-y-2">
			<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
				{Object.entries(storeState.menuItems).map(([key, comparison]) => {
					const name = key as keyof L.KnownLayer
					const setComp = applySetFilterFieldComparison(name)
					function clear() {
						setComp(
							Im.produce((prev) => {
								delete prev.value
							}),
						)
						// @ts-expect-error idgaf
						if (L.LAYER_STRING_PROPERTIES.includes(name)) {
							props.filterMenuStore.getState().setMenuItems(
								Im.produce((draft) => {
									delete draft['Layer'].value
								}),
							)
						}
					}

					const swapFactionsDisabled = !(
						['Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Alliance_1', 'Alliance_2'].some(key =>
							storeState.menuItems[key as keyof L.KnownLayer].value !== undefined
						)
					)

					let constraints = props.queryContext.constraints ?? []
					if (storeState.siblingFilters[name]) {
						constraints = [
							...constraints,
							LQY.filterToConstraint(storeState.siblingFilters[name], 'sibling-' + name),
						]
					}

					return (
						<React.Fragment key={name}>
							{(name === 'Map' || name === 'Alliance_1') && <Separator className="col-span-4 my-2" />}
							{name === 'Alliance_2' && (
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
								highlight={F.editableComparisonHasValue(comparison)}
								comp={comparison}
								setComp={setComp}
								baseQueryInput={{ ...props.queryContext, constraints }}
								lockOnSingleOption={true}
							/>
							<Button disabled={comparison.value === undefined} variant="ghost" size="icon" onClick={clear}>
								<Icons.Trash />
							</Button>
						</React.Fragment>
					)
				})}
			</div>
			<div>
				<Button variant="secondary" onClick={() => props.filterMenuStore.getState().setMenuItems(LFM.getDefaultFilterMenuItemState({}))}>
					Clear All
				</Button>
			</div>
			<ExtraFiltersPanel />
		</div>
	)
}
