import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import React from 'react'
import LayerTable from './layer-table.tsx'

export default function TableStyleLayerPicker(props: {
	queryContext: LQY.LayerQueryBaseInput
	selected: L.LayerId[]
	onSelect: React.Dispatch<React.SetStateAction<L.LayerId[]>>
	maxSelected?: number
	extraPanelItems?: React.ReactNode
}) {
	const [pageIndex, setPageIndex] = React.useState(0)

	return (
		<div className="flex h-full">
			<LayerTable
				baseInput={props.queryContext}
				pageIndex={pageIndex}
				autoSelectIfSingleResult={props.maxSelected === 1}
				setPageIndex={setPageIndex}
				selected={props.selected}
				setSelected={props.onSelect}
				maxSelected={props.maxSelected}
				enableForceSelect={true}
				canChangeRowsPerPage={false}
				canToggleColumns={false}
				extraPanelItems={props.extraPanelItems}
			/>
		</div>
	)
}
