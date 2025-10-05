import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { initMutationState } from '@/lib/item-mutations.ts'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand.ts'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import * as LFM from '@/models/layer-filter-menu.models.ts'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import * as QD from '@/systems.client/queue-dashboard.ts'
import { useLoggedInUser } from '@/systems.client/users.client'

import React from 'react'
import * as Zus from 'zustand'
import ExtraFiltersPanel from './extra-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import PoolCheckboxes from './pool-checkboxes.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'

export type EditLayerListItemDialogProps = {
	children?: React.ReactNode
} & InnerEditLayerListItemDialogProps

// index
// itemStore
type InnerEditLayerListItemDialogProps = {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	itemStore: Zus.StoreApi<QD.LLItemStore>
	layerQueryBaseInput?: LQY.LayerQueryBaseInput
}

export default function EditLayerListItemDialogWrapper(props: EditLayerListItemDialogProps) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			{props.children && <DialogTrigger asChild>{props.children}</DialogTrigger>}
			<DialogContent className="w-auto max-w-full min-w-0 pb-2 overflow-x-auto">
				<DragContextProvider>
					<EditLayerListItemDialog {...props} />
				</DragContextProvider>
			</DialogContent>
		</Dialog>
	)
}

function EditLayerListItemDialog(props: InnerEditLayerListItemDialogProps) {
	const [initialItem] = ZusUtils.useStoreDeep(
		props.itemStore,
		(s) => [s.item, s.index, s.innerIndex, s.isVoteChoice],
		{ dependencies: [] },
	)

	const editedItemStore = React.useMemo(() => {
		return Zus.create<QD.LLItemStore>((set, get) =>
			QD.createLLItemStore(set, get, { ...props.itemStore.getState(), mutationState: initMutationState() })
		)
	}, [props.itemStore])
	const editedItem = Zus.useStore(editedItemStore, (s) => s.item)

	const colConfig = ConfigClient.useEffectiveColConfig()

	const loggedInUser = useLoggedInUser()

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

	const canSubmit = Zus.useStore(
		editedItemStore,
		(s) => !Obj.deepEqual(initialItem, s.item) && (!LL.isParentVoteItem(s.item) || s.item.choices.length > 0),
	)

	function submit() {
		if (!canSubmit) return
		props.onOpenChange(false)
		const source: LL.LayerSource = { type: 'manual', userId: loggedInUser!.discordId }
		props.itemStore.getState().setItem({ ...editedItemStore.getState().item, source })
	}
	const layerItemsState = QD.useLayerItemsState()
	const extraFiltersStore = QD.useExtraFiltersStore(true)
	const applyAsStore = QD.useNewPoolApplyAsStore({ dnr: 'field', filter: 'field' })

	const queryInputs = ZusUtils.useCombinedStoresDeep(
		[QD.QDStore, filterMenuStore, editedItemStore, extraFiltersStore, applyAsStore],
		(args) => {
			const [qdState, filterMenuState, editedLayerListItemState, extraFiltersState, applyAsStore] = args
			let constraints = QD.selectBaseQueryConstraints(qdState, applyAsStore.poolApplyAs)
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

	if (LL.isParentVoteItem(editedItem)) {
		console.warn('Opened edit dialog for a parent vote item')
		return null
	}

	return (
		<>
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<DialogTitle>Edit</DialogTitle>
				</div>
				<div className="flex justify-end items-center space-x-2 flex-grow">
					<ExtraFiltersPanel store={extraFiltersStore} />
				</div>
			</DialogHeader>

			{
				<div className="flex items-start space-x-2 min-h-0">
					<LayerFilterMenu layerQueryBaseInput={queryInputs.editItem} filterMenuStore={filterMenuStore} />
					<div className="flex flex-col h-full justify-between">
						<TableStyleLayerPicker
							defaultPageSize={16}
							queryContext={queryInputs.editItemWithFilterMenu}
							editingSingleValue={true}
							selected={[editedItem.layerId!]}
							onSelect={(update) => {
								const id = (typeof update === 'function' ? update([]) : update)[0]
								if (!id) return
								return editedItemStore.getState().setItem((prev) => ({ ...prev, layerId: id }))
							}}
							extraPanelItems={<PoolCheckboxes store={applyAsStore} />}
						/>
						<div className="flex justify-end">
							<Button disabled={!canSubmit} onClick={submit}>
								Submit
							</Button>
						</div>
					</div>
				</div>
			}
		</>
	)
}
