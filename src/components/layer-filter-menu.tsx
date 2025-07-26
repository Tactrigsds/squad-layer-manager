import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { selectProps } from '@/lib/object.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LFM from '@/models/layer-filter-menu.models'
import * as LQY from '@/models/layer-queries.models'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { Comparison } from './filter-card'

export default function LayerFilterMenu(
	props: { filterMenuStore: Zus.StoreApi<LFM.FilterMenuStore>; queryContext: LQY.LayerQueryBaseInput },
) {
	const storeState = ZusUtils.useStoreDeep(
		props.filterMenuStore,
		state => selectProps(state, ['menuItems', 'siblingFilters']),
	)

	return (
		<div className="flex flex-col space-y-2">
			<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
				{Object.entries(storeState.menuItems).map(([key, comparison]) => {
					const field = key as keyof L.KnownLayer
					const swapFactionsDisabled = !(
						['Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Alliance_1', 'Alliance_2'].some(key =>
							storeState.menuItems[key as keyof L.KnownLayer].value !== undefined
						)
					)

					let constraints = props.queryContext.constraints ?? []
					if (storeState.siblingFilters[field]) {
						constraints = [
							...constraints,
							LQY.filterToConstraint(storeState.siblingFilters[field], 'sibling-' + field),
						]
					}

					return (
						<React.Fragment key={field}>
							{(field === 'Map' || field === 'Alliance_1') && <Separator className="col-span-4 my-2" />}
							{field === 'Alliance_2' && (
								<>
									<Button
										title="Swap Factions"
										disabled={swapFactionsDisabled}
										onClick={() => props.filterMenuStore.getState().swapTeams()}
										size="icon"
										variant="outline"
									>
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
								setComp={(update) => props.filterMenuStore.getState().setComparison(field, update)}
								baseQueryInput={{ ...props.queryContext, constraints }}
								lockOnSingleOption={true}
							/>
							<Button
								disabled={comparison.value === undefined}
								variant="ghost"
								size="icon"
								onClick={() => props.filterMenuStore.getState().clear(field)}
							>
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
		</div>
	)
}
