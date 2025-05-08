import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import * as M from '@/models'
import { useLoggedInUser } from '@/systems.client/logged-in-user'
import * as QD from '@/systems.client/queue-dashboard'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import LayerFilterMenu, { useFilterMenuStore, useQueryContextWithMenuFilter } from './layer-filter-menu.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Label } from './ui/label.tsx'
import TabsList from './ui/tabs-list.tsx'

type SelectMode = 'vote' | 'layers'

export default function SelectLayersDialog(props: {
	title: string
	description: React.ReactNode
	pinMode?: SelectMode
	children: React.ReactNode
	selectQueueItems: (queueItems: M.NewLayerListItem[]) => void
	defaultSelected?: M.LayerId[]
	selectingSingleLayerQueueItem?: boolean
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	layerQueryContext: M.LayerQueryContext
}) {
	const defaultSelected: M.LayerId[] = props.defaultSelected ?? []

	const filterMenuStore = useFilterMenuStore()

	const [selectedLayers, setSelectedLayers] = React.useState<M.LayerId[]>(defaultSelected)
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

	const canSubmit = selectedLayers.length > 0
	function submit() {
		if (!canSubmit) return
		if (selectMode === 'layers' || selectedLayers.length === 1) {
			const items = selectedLayers.map(
				(layerId) =>
					({
						layerId: layerId,
						source: { type: 'manual', userId: user!.discordId },
					}) satisfies M.NewLayerListItem,
			)
			props.selectQueueItems(items)
		} else if (selectMode === 'vote') {
			const item: M.NewLayerListItem = {
				vote: {
					choices: selectedLayers,
					defaultChoice: selectedLayers[0],
				},
				source: { type: 'manual', userId: user!.discordId },
			}
			props.selectQueueItems([item])
		}
		onOpenChange(false)
	}

	function onOpenChange(open: boolean) {
		if (open) {
			setSelectedLayers(defaultSelected)
		}
		props.onOpenChange(open)
	}

	const queryContextWithFilter = useQueryContextWithMenuFilter(props.layerQueryContext, filterMenuStore)

	return (
		<Dialog open={props.open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0">
				<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
					<div className="flex items-center space-x-2">
						<DialogTitle>{props.title}</DialogTitle>
						<div className="mx-8 font-light">-</div>
						<DialogDescription>{props.description}</DialogDescription>
					</div>
					<div className="flex items-center space-x-2">
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
					</div>
				</DialogHeader>

				<div className="flex min-h-0 items-start space-x-2">
					<LayerFilterMenu queryContext={props.layerQueryContext} filterMenuStore={filterMenuStore} />
					<TableStyleLayerPicker
						queryContext={queryContextWithFilter}
						selected={selectedLayers}
						onSelect={setSelectedLayers}
						extraPanelItems={<PoolCheckboxes />}
					/>
				</div>

				<DialogFooter>
					<Button disabled={!canSubmit} onClick={submit}>
						Submit
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
