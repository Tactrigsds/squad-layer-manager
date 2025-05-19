import * as M from '@/models'
import React from 'react'
import LayerTable from './layer-table.tsx'

export default function TableStyleLayerPicker(props: {
	queryContext: M.LayerQueryContext
	selected: M.LayerId[]
	onSelect: React.Dispatch<React.SetStateAction<M.LayerId[]>>
	maxSelected?: number
	extraPanelItems?: React.ReactNode
}) {
	const [pageIndex, setPageIndex] = React.useState(0)

	const defaultColumns: (M.LayerColumnKey | M.LayerCompositeKey)[] = [
		'Layer',
		'Faction_1',
		'SubFac_1',
		'Faction_2',
		'SubFac_2',
		'Asymmetry_Score',
		'Balance_Differential',
	]

	return (
		<div className="flex h-full">
			<LayerTable
				queryContext={props.queryContext}
				defaultColumns={defaultColumns}
				pageIndex={pageIndex}
				autoSelectIfSingleResult={props.maxSelected === 1}
				setPageIndex={setPageIndex}
				selected={props.selected}
				setSelected={props.onSelect}
				maxSelected={props.maxSelected}
				enableForceSelect={true}
				defaultSortBy="Asymmetry_Score"
				defaultSortDirection="ASC"
				canChangeRowsPerPage={false}
				canToggleColumns={false}
				extraPanelItems={props.extraPanelItems}
			/>
		</div>
	)
}
