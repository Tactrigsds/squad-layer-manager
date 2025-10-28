import { cn } from '@/lib/utils.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import React from 'react'
import LayerTable from './layer-table.tsx'

export default function TableStyleLayerPicker(props: {
	// make sure this reference is stable
	queryContext: LQY.LayerQueryBaseInput
	selected: L.LayerId[]
	onSelect: React.Dispatch<React.SetStateAction<L.LayerId[]>>
	editingSingleValue?: boolean
	extraPanelItems?: React.ReactNode
	className?: string
	defaultPageSize?: number
}) {
	const [pageIndex, setPageIndex] = React.useState(0)

	return (
		<div className={cn('flex h-full', props.className)}>
			<LayerTable
				defaultPageSize={props.defaultPageSize}
				baseInput={props.queryContext}
				pageIndex={pageIndex}
				defaultSort={{ type: 'random', seed: LQY.getSeed() }}
				editingSingleValue={props.editingSingleValue}
				setPageIndex={setPageIndex}
				selected={props.selected}
				setSelected={props.onSelect}
				enableForceSelect={true}
				canChangeRowsPerPage={false}
				canToggleColumns={false}
				extraPanelItems={props.extraPanelItems}
			/>
		</div>
	)
}
