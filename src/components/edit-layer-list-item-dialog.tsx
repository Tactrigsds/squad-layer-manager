import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { initMutationState } from '@/lib/item-mutations.ts'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import { isEnumeratedValue } from '@/models/layer-columns.ts'
import * as LFM from '@/models/layer-filter-menu.models.ts'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import { useLoggedInUser } from '@/systems.client/users.client'
import deepEqual from 'fast-deep-equal'
import React from 'react'
import * as Zus from 'zustand'
import ExtraFiltersPanel from './extra-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import { LayerList } from './layer-list.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'

export type EditLayerListItemDialogProps = {
	children: React.ReactNode
} & InnerEditLayerListItemDialogProps

// index
// itemStore
type InnerEditLayerListItemDialogProps = {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	allowVotes?: boolean
	itemStore: Zus.StoreApi<QD.LLItemStore>
	layerQueryBaseInput?: LQY.LayerQueryBaseInput
}

export default function EditLayerListItemDialogWrapper(props: EditLayerListItemDialogProps) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0 pb-2">
				<DragContextProvider>
					<EditLayerListItemDialog {...props} />
				</DragContextProvider>
			</DialogContent>
		</Dialog>
	)
}

function EditLayerListItemDialog(props: InnerEditLayerListItemDialogProps) {
	const allowVotes = props.allowVotes ?? true

	const [initialItem, index] = ZusUtils.useStoreDeep(
		props.itemStore,
		(s) => [s.item, s.index],
		{ dependencies: [] },
	)

	const editedItemStore = React.useMemo(() => {
		return Zus.create<QD.LLItemStore>((set, get) =>
			QD.createLLItemStore(set, get, { item: initialItem, mutationState: initMutationState(), index })
		)
	}, [initialItem, index])
	const editedItem = Zus.useStore(editedItemStore, (s) => s.item)

	const editedVoteChoiceStore = QD.useVoteChoiceStore(editedItemStore)
	const colConfig = ConfigClient.useEffectiveColConfig()

	const loggedInUser = useLoggedInUser()
	const [itemType, setItemType] = React.useState<'vote' | 'set-layer'>(editedItem.vote ? 'vote' : 'set-layer')

	const [addLayersOpen, setAddLayersOpen] = React.useState(false)

	let filterMenuItemDefaults: Partial<L.KnownLayer> = {}
	if (editedItem.layerId && colConfig) {
		const layer = L.toLayer(editedItem.layerId)
		if (layer.Gamemode === 'Training') {
			filterMenuItemDefaults = { Gamemode: 'Training' }
		} else {
			filterMenuItemDefaults = Obj.exclude(layer, ['Alliance_1', 'Alliance_2', 'id', 'Size'])
			for (const [key, value] of Obj.objEntries(filterMenuItemDefaults)) {
				if (value === undefined) continue
				const colDef = LC.getColumnDef(key)
				if (
					colDef?.type === 'string' && colDef.enumMapping && !LC.isEnumeratedValue(key, value as string, { effectiveColsConfig: colConfig })
				) {
					delete filterMenuItemDefaults[key]
				}
			}
		}
	}
	filterMenuItemDefaults = { ...filterMenuItemDefaults }

	const filterMenuStore = LFM.useFilterMenuStore(filterMenuItemDefaults)

	const canSubmitSetLayer = Zus.useStore(
		editedItemStore,
		(s) => !deepEqual(initialItem, s.item) && (!s.item.vote || s.item.vote.choices.length > 0),
	)
	const canSubmitVoteChoices = Zus.useStore(editedVoteChoiceStore, s => s.layerList.length > 0)
	const canSubmit = itemType === 'set-layer' ? canSubmitSetLayer : canSubmitVoteChoices

	// const voteChoiceAddLayersQueryContext = React.useMemo(() => (
	// 	LQY.getQueryContextForAddingVoteChoice(fullQueryContext, editedItem.itemId)
	// ), [editedItem.itemId, fullQueryContext])
	//

	function submit() {
		if (!canSubmit) return
		props.onOpenChange(false)
		const source: LL.LayerSource = { type: 'manual', userId: loggedInUser!.discordId }
		if (itemType === 'vote') {
			const itemState = editedItemStore.getState()
			const choices = editedVoteChoiceStore.getState().layerList.map(item => item.layerId!)
			if (choices.length === 0) {
				return
			}
			if (choices.length === 1) {
				props.itemStore.getState().setItem({ ...itemState.item, vote: undefined, layerId: choices[0], source })
				return
			}
			const defaultChoice = choices.length > 0 ? choices[0] : L.DEFAULT_LAYER_ID

			// ensure that if this vote has already been decideed then we overwrite it when the choice is remove
			let layerId: string | undefined
			if (itemState.item.layerId) {
				if (choices.includes(itemState.item.layerId)) {
					layerId = itemState.item.layerId
				} else {
					layerId = choices[0]
				}
			}

			props.itemStore.getState().setItem({ itemId: itemState.item.itemId, layerId, vote: { choices, defaultChoice }, source })
		} else {
			props.itemStore.getState().setItem({ ...editedItemStore.getState().item, source })
		}
	}
	const layerItemsState = QD.useLayerItemsState()
	const extraFiltersStore = QD.useExtraFiltersStore(true)

	const queryInputs = ZusUtils.useCombinedStoresDeep(
		[QD.QDStore, filterMenuStore, editedItemStore, extraFiltersStore],
		(args) => {
			const [qdState, filterMenuState, editedLayerListItemState, extraFiltersState] = args
			let constraints = QD.selectBaseQueryConstraints(qdState)
			const addVoteChoice: LQY.LayerQueryBaseInput = LQY.getBaseQueryInputForAddingVoteChoice(
				layerItemsState,
				constraints,
				editedLayerListItemState.item.itemId,
			)
			// it's  intentional to add this after addVoteChoice
			constraints = [...constraints, ...QD.getExtraFiltersConstraints(extraFiltersState)]
			const editItem = {
				constraints,
				cursor: LQY.getQueryCursorForLayerItem(LQY.getLayerItemForLayerListItem(editedLayerListItemState.item), 'edit'),
			} satisfies LQY.LayerQueryBaseInput
			const editItemWithFilterMenu: LQY.LayerQueryBaseInput = {
				cursor: editItem.cursor,
				constraints: [...constraints, ...LFM.selectFilterMenuConstraints(filterMenuState)],
				patches: [{
					type: 'splice',
					deleteCount: 1,
					cursor: LQY.getQueryCursorForLayerItem(LQY.getLayerItemForLayerListItem(initialItem), 'edit'),
					insertions: [LQY.getLayerItemForLayerListItem(editedLayerListItemState.item) as LQY.LayerItem],
				}],
			}
			return {
				addVoteChoice,
				editItem,
				editItemWithFilterMenu,
			}
		},
		{ selectorDeps: [layerItemsState, initialItem] },
	)

	function toggleItemType() {
		if (!allowVotes) return
		const newItemType = itemType === 'vote' ? 'set-layer' : 'vote'
		setItemType(newItemType)
		switch (newItemType) {
			case 'vote': {
				const newState = QD.getVoteChoiceStateFromItem(editedItemStore.getState())
				if (editedItem.layerId) {
					newState.layerList = [LL.createLayerListItem({ layerId: editedItem.layerId, source: editedItem.source })]
				} else {
					newState.layerList = []
				}
				editedVoteChoiceStore.setState(newState)
				editedItemStore.getState().setItem({
					itemId: editedItem.itemId,
					vote: { choices: [editedItem.layerId!], defaultChoice: editedItem.layerId! },
					source: editedItem.source,
				})
				break
			}
			case 'set-layer': {
				editedItemStore.getState().setItem(prev => {
					const selectedLayerIds = itemToLayerIds(prev)
					return {
						...prev,
						itemId: prev.itemId,
						layerId: selectedLayerIds[0],
						vote: undefined,
					} satisfies LL.LayerListItem
				})
				break
			}
			default:
				assertNever(newItemType)
		}
	}

	const mainPoolConstraints = ZusUtils.useStoreDeep(QD.QDStore, QD.selectBaseQueryConstraints, { dependencies: [] })
	const layerStatusesRes = LayerQueriesClient.useLayerItemStatuses()
	let mainPoolFiltered = false
	const item = LQY.getLayerItemForLayerListItem(editedItem)
	if (!LQY.isParentVoteItem(item)) {
		const layerItemId = LQY.toLayerItemId(item)
		const blockedConstraintIds = layerStatusesRes.data?.blocked.get(layerItemId)
		if (blockedConstraintIds) {
			for (const constraint of mainPoolConstraints) {
				if (blockedConstraintIds.has(constraint.id)) {
					if (constraint.type === 'filter-entity') {
						mainPoolFiltered = true
					}
					break
				}
			}
		}
	}

	if (!props.allowVotes && editedItem.vote) throw new Error('Invalid queue item')

	return (
		<>
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<DialogTitle>Edit</DialogTitle>
				</div>
				<div className="flex justify-end items-center space-x-2 flex-grow">
					<ExtraFiltersPanel store={extraFiltersStore} />
					{allowVotes && (
						<Button
							variant="outline"
							onClick={toggleItemType}
						>
							{itemType === 'vote' ? 'Convert to Set Layer' : 'Convert to Vote'}
						</Button>
					)}
				</div>
			</DialogHeader>

			{itemType === 'vote'
				? (
					<div className="flex flex-col">
						<div className="flex w-min"></div>
						<div>
							<LayerList store={editedVoteChoiceStore} />
							<div>
								<div className="flex justify-end space-x-2">
									<SelectLayersDialog
										title="Add"
										description="Select layers to add to the voting pool"
										open={addLayersOpen}
										pinMode="layers"
										onOpenChange={setAddLayersOpen}
										layerQueryBaseInput={queryInputs.addVoteChoice}
										selectQueueItems={(items) => {
											editedVoteChoiceStore.getState().add(items)
										}}
									>
										<Button variant="secondary" size="sm" onClick={() => setAddLayersOpen(true)}>Add layers</Button>
									</SelectLayersDialog>
									<Button disabled={!canSubmit} onClick={submit}>
										Submit
									</Button>
								</div>
							</div>
						</div>
					</div>
				)
				: (
					<div className="flex items-start space-x-2 min-h-0">
						<LayerFilterMenu layerQueryBaseInput={queryInputs.editItem} filterMenuStore={filterMenuStore} />
						<div className="flex flex-col h-full justify-between">
							<TableStyleLayerPicker
								defaultPageSize={12}
								queryContext={queryInputs.editItemWithFilterMenu}
								editingSingleValue={true}
								selected={[editedItem.layerId!]}
								onSelect={(update) => {
									const id = (typeof update === 'function' ? update([]) : update)[0]
									if (!id) return
									return editedItemStore.getState().setItem((prev) => ({ ...prev, layerId: id }))
								}}
								extraPanelItems={
									<PoolCheckboxes
										ephemeralState={true}
										defaultState={{
											dnr: 'field',
											filter: mainPoolFiltered ? 'field' : 'where-condition',
										}}
									/>
								}
							/>
							<div className="flex justify-end">
								<Button disabled={!canSubmit} onClick={submit}>
									Submit
								</Button>
							</div>
						</div>
					</div>
				)}
		</>
	)
}

function itemToLayerIds(item: LL.LayerListItem): L.LayerId[] {
	let layers: L.LayerId[]
	if (item.vote) {
		layers = item.vote.choices
	} else if (item.layerId) {
		layers = [item.layerId]
	} else {
		throw new Error('Invalid LayerQueueItem')
	}
	return layers
}
