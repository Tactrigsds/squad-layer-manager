import { useFrameStore } from '@/frames/frame-manager.ts'
import type * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { assertNever } from '@/lib/type-guards.ts'
import type * as SS from '@/models/server-state.models.ts'
import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { TriStateCheckbox } from './ui/tri-state-checkbox'

export default function PoolCheckboxes(props: { frameKey: SelectLayersFrame.Key }) {
	const [checkboxes, setCheckbox] = useFrameStore(
		props.frameKey,
		useShallow(s => [s.checkboxesState, s.setCheckbox]),
	)

	return (
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
	)
}

function invertApplyAs(applyAs: SS.ConstraintApplyAs): SS.ConstraintApplyAs {
	if (applyAs === 'inverted') return 'regular'
	if (applyAs === 'regular') return 'inverted'
	if (applyAs === 'disabled') return 'disabled'
	assertNever(applyAs)
}
