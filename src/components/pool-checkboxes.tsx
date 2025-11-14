import { useFrameStore } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { assertNever } from '@/lib/type-guards.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Label } from './ui/label.tsx'
import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'

export default function PoolCheckboxes(props: { frameKey: SelectLayersFrame.Key }) {
	const [checkboxes, setCheckbox] = useFrameStore(
		props.frameKey,
		useShallow(s => [s.checkboxesState, s.setCheckbox]),
	)

	return (
		<>
			<div className="flex items-center flex-nowrap whitespace-nowrap space-x-1">
				<TriStateCheckbox
					title="Hide layers which violate Repeat rules"
					size="sm"
					variant="ghost"
					onCheckedChange={v => {
						setCheckbox('dnr', invertApplyAs(v))
					}}
					checked={invertApplyAs(checkboxes.dnr)}
				>
					Hide Repeats
				</TriStateCheckbox>
			</div>
		</>
	)
}

function invertApplyAs(applyAs: SS.ConstraintApplyAs): SS.ConstraintApplyAs {
	if (applyAs === 'inverted') return 'regular'
	if (applyAs === 'regular') return 'inverted'
	if (applyAs === 'disabled') return 'disabled'
	assertNever(applyAs)
}
