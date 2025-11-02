import { useFrameStore } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Checkbox } from './ui/checkbox.tsx'
import { Label } from './ui/label.tsx'

export default function PoolCheckboxes(props: { frameKey: SelectLayersFrame.Key }) {
	const [checkboxes, setCheckbox] = useFrameStore(
		props.frameKey,
		useShallow(s => [s.checkboxesState, s.setCheckbox]),
	)
	const dnrCheckboxId = React.useId()

	return (
		<>
			<div className="flex items-center flex-nowrap whitespace-nowrap space-x-0.5">
				<Label title="Hide layers which violate Repeat rules" htmlFor={dnrCheckboxId}>Hide Repeats</Label>
				<Checkbox
					id={dnrCheckboxId}
					onCheckedChange={v => {
						if (v === 'indeterminate') return
						setCheckbox('dnr', v)
					}}
					checked={checkboxes.dnr}
				/>
			</div>
		</>
	)
}
