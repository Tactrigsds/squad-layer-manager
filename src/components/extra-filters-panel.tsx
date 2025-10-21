import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as Typography from '@/lib/typography.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as Icons from 'lucide-react'
import * as Zus from 'zustand'
import FilterEntitySelect from './filter-entity-select.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Label } from './ui/label.tsx'

export default function ExtraFiltersPanel({ store }: { store: Zus.StoreApi<LQY.ExtraQueryFiltersStore> }) {
	const filterEntities = FilterEntityClient.useFilterEntities()
	const state = Zus.useStore(store)
	const extraFilters = Array.from(state.filters)

	return (
		<div className="flex items-center">
			{Array.from(state.filters).map((filterId) => {
				const htmlId = 'filter-list:' + filterId
				const active = state.activeFilters.has(filterId)
				return (
					<div key={filterId} className="flex items-center space-x-0.5 p-2">
						<Label htmlFor={htmlId}>{filterEntities.get(filterId)?.name}</Label>
						<Checkbox
							id={htmlId}
							checked={active}
							onCheckedChange={checked => {
								if (checked === 'indeterminate') return
								store.getState().setActive(filterId, checked)
							}}
						/>
					</div>
				)
			})}
			<Popover>
				<PopoverTrigger asChild>
					<Button title="Edit extra filters" variant="ghost">
						<Icons.Edit />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-min">
					<h4 className={Typography.H4}>Edit Extra Filters</h4>
					<div className="space-y-4">
						<ul>
							{extraFilters.map(filterId => {
								const excluded = extraFilters.filter(f => filterId !== f)
								const active = state.activeFilters.has(filterId)
								return (
									<li className="flex items-center space-x-0.5" key={filterId}>
										<FilterEntitySelect
											className="flex-grow"
											filterId={filterId}
											allowEmpty={false}
											allowToggle={true}
											enabled={active}
											setEnabled={enabled => {
												store.getState().setActive(filterId, enabled)
											}}
											excludedFilterIds={excluded}
											onSelect={(id) => {
												if (id === null) return
												store.getState().select(id, filterId)
											}}
										/>
										<Button
											size="icon"
											variant="ghost"
											onClick={() => {
												store.getState().remove(filterId)
											}}
										>
											<Icons.X />
										</Button>
									</li>
								)
							})}
						</ul>
						<FilterEntitySelect
							title="Extra Filter"
							filterId={null}
							allowEmpty={true}
							excludedFilterIds={extraFilters}
							onSelect={(id) => {
								if (id === null) return
								store.getState().add(id, true)
							}}
						>
							<Button variant="secondary">
								<Icons.Plus />
								Add Extra Filter
							</Button>
						</FilterEntitySelect>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	)
}
