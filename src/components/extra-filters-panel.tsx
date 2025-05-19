import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as Icons from 'lucide-react'
import * as Zus from 'zustand'
import FilterEntitySelect from './filter-entity-select.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Label } from './ui/label.tsx'

export default function ExtraFiltersPanel() {
	const extraFilters = Zus.useStore(QD.QDStore, s => s.extraQueryFilters)
	const filterEntities = FilterEntityClient.useFilterEntities()

	return (
		<div className="flex flex-col space-x-2">
			<h3 className={cn(Typography.H4, 'whitespace-nowrap')}>Extra filters:</h3>
			<div className="flex items-center flex-wrap">
				{extraFilters.map(({ filterId, active }) => {
					const htmlId = 'filter-list:' + filterId
					return (
						<div key={filterId} className="flex items-center space-x-0.5 p-2">
							<Label htmlFor={htmlId}>{filterEntities.get(filterId)?.name}</Label>
							<Checkbox
								id={htmlId}
								checked={active}
								onCheckedChange={checked => {
									if (checked === 'indeterminate') return
									const actions = QD.QDStore.getState().extraQueryFilterActions
									actions.setActive(filterId, checked)
								}}
							/>
						</div>
					)
				})}
			</div>
			<Popover>
				<PopoverTrigger asChild>
					<Button variant="outline" size="icon">
						<Icons.Edit />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-min">
					<h4 className={Typography.H4}>Edit Extra Filters</h4>
					<div className="space-y-4">
						<ul>
							{extraFilters.map(filter => {
								const excluded = extraFilters.map(f => f.filterId).filter((id) => filter.filterId !== id)
								return (
									<li className="flex items-center space-x-0.5" key={filter.filterId}>
										<FilterEntitySelect
											className="flex-grow"
											filterId={filter.filterId}
											allowEmpty={false}
											allowToggle={true}
											enabled={filter.active}
											setEnabled={enabled => {
												const actions = QD.QDStore.getState().extraQueryFilterActions
												actions.setActive(filter.filterId, enabled)
											}}
											excludedFilterIds={excluded}
											onSelect={(id) => {
												const actions = QD.QDStore.getState().extraQueryFilterActions
												if (id === null) return
												actions.select(id, filter.filterId)
											}}
										/>
										<Button
											size="icon"
											variant="ghost"
											onClick={() => {
												const actions = QD.QDStore.getState().extraQueryFilterActions
												actions.remove(filter.filterId)
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
							excludedFilterIds={extraFilters.map(f => f.filterId)}
							onSelect={(id) => {
								const actions = QD.QDStore.getState().extraQueryFilterActions
								if (id === null) return
								actions.add(id, true)
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
