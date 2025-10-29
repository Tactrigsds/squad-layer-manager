import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import * as Obj from '@/lib/object'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import React from 'react'
import ExtraFiltersPanel from './extra-filters-panel.tsx'
import LayerFilterMenu from './layer-filter-menu.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'

export type EditLayerDialogProps = {
	children?: React.ReactNode
} & InnerEditLayerDialogProps

// index
// itemStore
type InnerEditLayerDialogProps = {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	layerId?: L.LayerId
	onSelectLayer: (layerId: L.LayerId) => void
	cursor?: LQY.LayerQueryCursor
}

export default function EditLayerDialogWrapper(props: EditLayerDialogProps) {
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

function EditLayerListItemDialog(props: InnerEditLayerDialogProps) {
	const colConfig = ConfigClient.useEffectiveColConfig()
	const [editedLayerId, setEditedLayerId] = React.useState(props.layerId)

	const filterMenuItemDefaults = React.useMemo(() => {
		let defaults: Partial<L.KnownLayer> = {}
		if (props.layerId && colConfig) {
			const layer = L.toLayer(props.layerId)
			if (layer.Gamemode === 'Training') {
				defaults = { Gamemode: 'Training' }
			} else {
				defaults = Obj.exclude(layer, ['Alliance_1', 'Alliance_2', 'id', 'Size'])
				for (const [key, value] of Obj.objEntries(defaults)) {
					if (value === undefined) continue
					const colDef = LC.getColumnDef(key)
					if (
						colDef?.type === 'string' && colDef.enumMapping
						&& !LC.isEnumeratedValue(key, value as string, { effectiveColsConfig: colConfig })
					) {
						delete defaults[key]
					}
				}
			}
		}
		return defaults
	}, [props.layerId, colConfig])
	const queryCtx = LayerQueriesClient.useFilterMenuLayerQueryContext(props.cursor, filterMenuItemDefaults)

	const canSubmit = !!editedLayerId && props.layerId !== editedLayerId

	function submit() {
		if (!canSubmit) return
		props.onOpenChange(false)
		props.onSelectLayer(editedLayerId!)
	}

	return (
		<>
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<DialogTitle>Edit</DialogTitle>
				</div>
				<div className="flex justify-end items-center space-x-2 flex-grow">
					<ExtraFiltersPanel store={queryCtx.extraFiltersStore} />
				</div>
			</DialogHeader>

			{
				<div className="flex items-start space-x-2 min-h-0">
					<LayerFilterMenu filterMenuStore={queryCtx.filterMenuStore} />
					<div className="flex flex-col h-full justify-between">
						<TableStyleLayerPicker
							defaultPageSize={16}
							queryInput={queryCtx.queryInput}
							editingSingleValue={true}
							selected={editedLayerId ? [editedLayerId] : []}
							onSelect={(update) => {
								const id = (typeof update === 'function' ? update([]) : update)[0]
								if (!id) return
								setEditedLayerId(id)
							}}
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
