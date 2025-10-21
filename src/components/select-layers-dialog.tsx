import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import { useLoggedInUser } from '@/systems.client/users.client'
import React from 'react'
import ExtraFiltersPanel from './extra-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'
import TabsList from './ui/tabs-list.tsx'

type SelectMode = 'vote' | 'layers'

export default function SelectLayersDialog(props: {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	children?: React.ReactNode
	selectQueueItems: (queueItems: LL.NewLayerListItem[]) => void
	defaultSelected?: L.LayerId[]
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	headerAdditions?: React.ReactNode
	layerQueryBaseInput: LQY.LayerQueryBaseInput
}) {
	const defaultSelected: L.LayerId[] = props.defaultSelected ?? []

	const [selectedLayers, setSelectedLayers] = React.useState<L.LayerId[]>(defaultSelected)
	const [selectMode, _setSelectMode] = React.useState<SelectMode>(props.pinMode ?? 'layers')
	function setAdditionType(newAdditionType: SelectMode) {
		if (newAdditionType === 'vote') {
			setSelectedLayers((prev) => {
				const seenIds = new Set<string>()
				return prev.filter((layerId) => {
					if (seenIds.has(layerId)) {
						return false
					}
					seenIds.add(layerId)
					return true
				})
			})
		}
		_setSelectMode(newAdditionType)
	}
	const user = useLoggedInUser()
	const [submitted, setSubmitted] = React.useState(false)

	const canSubmit = selectedLayers.length > 0 && !submitted
	function submit() {
		if (!canSubmit) return
		setSubmitted(true)
		try {
			const source: LL.Source = { type: 'manual', userId: user!.discordId }
			if (selectMode === 'layers' || selectedLayers.length === 1) {
				const items = selectedLayers.map(
					(layerId) =>
						({
							layerId: layerId,
						}) satisfies LL.NewLayerListItem,
				)
				props.selectQueueItems(items)
			} else if (selectMode === 'vote') {
				const item: LL.NewLayerListItem = {
					layerId: selectedLayers[0],
					choices: selectedLayers.map(layerId => LL.createLayerListItem({ layerId }, source)),
				}
				props.selectQueueItems([item])
			}
			onOpenChange(false)
		} finally {
			setSubmitted(false)
		}
	}

	function onOpenChange(open: boolean) {
		if (open) {
			setSelectedLayers(defaultSelected)
		}
		props.onOpenChange?.(open)
	}

	const queryCtx = LayerQueriesClient.useFilterMenuLayerQueryContext(props.layerQueryBaseInput)

	return (
		<Dialog open={props.open} onOpenChange={onOpenChange}>
			{props.children && <DialogTrigger asChild>{props.children}</DialogTrigger>}
			<DialogContent className="w-auto max-w-full overflow-x-auto min-w-0 pb-2">
				<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
					<div className="flex items-center space-x-2">
						<DialogTitle>{props.title}</DialogTitle>
						{props.description
							&& (
								<>
									<div className="mx-8 font-light">-</div>
									<DialogDescription>{props.description}</DialogDescription>
								</>
							)}
					</div>
					<div className="flex justify-end items-center space-x-2 flex-grow">
						<ExtraFiltersPanel store={queryCtx.extraFiltersStore} />
						{!props.pinMode && (
							<TabsList
								options={[
									{ label: 'Vote', value: 'vote' },
									{ label: 'Set Layer', value: 'layers' },
								]}
								active={selectMode}
								setActive={setAdditionType}
							/>
						)}
						{props.headerAdditions}
					</div>
				</DialogHeader>

				<div className="flex min-h-0 items-start space-x-2">
					<LayerFilterMenu layerQueryBaseInput={queryCtx.queryInput} filterMenuStore={queryCtx.filterMenuStore} />
					<div className="flex flex-col space-y-2 justify-between h-full">
						<TableStyleLayerPicker
							defaultPageSize={16}
							queryContext={queryCtx.filteredQueryInput}
							selected={selectedLayers}
							onSelect={setSelectedLayers}
							extraPanelItems={<PoolCheckboxes store={queryCtx.applyAsStore} />}
							className="flex-grow"
						/>

						<div className="grow self-end">
							<Button disabled={!canSubmit} onClick={submit}>
								Submit
							</Button>
						</div>
					</div>
				</div>

				<DialogFooter>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
