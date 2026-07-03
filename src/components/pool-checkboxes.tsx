import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import { assertNever } from '@/lib/type-guards.ts'
import * as ZusUtils from '@/lib/zustand'
import type * as SETTINGS from '@/models/settings.models.ts'
import React from 'react'
import { TriStateCheckbox } from './ui/tri-state-checkbox'

export default function PoolCheckboxes(props: { stores: PoolCheckboxesPrt.KeyProp }) {
	const checkboxes = ZusUtils.useStore(
		props.stores.poolCheckboxes,
		PoolCheckboxesPrt.Sel.checkboxesState,
	)

	return (
		<div className="flex items-center flex-nowrap whitespace-nowrap space-x-1">
			<TriStateCheckbox
				title="Hide layers which violate Repeat rules"
				size="sm"
				variant="ghost"
				onCheckedChange={v => {
					PoolCheckboxesPrt.Actions.setCheckbox(props.stores, 'dnr', invertApplyAs(v))
				}}
				checked={invertApplyAs(checkboxes.dnr)}
			>
				Hide Repeats
			</TriStateCheckbox>
		</div>
	)
}

function invertApplyAs(applyAs: SETTINGS.PoolFilterApplyAs): SETTINGS.PoolFilterApplyAs {
	switch (applyAs) {
		case 'inverted':
			return 'regular'
		case 'regular':
			return 'inverted'
		case 'disabled':
			return 'disabled'
		default:
			assertNever(applyAs)
	}
}
