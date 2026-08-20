import React from 'react'

import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import { assertNever } from '@/lib/type-guards.ts'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import type * as SETTINGS from '@/models/settings.models.ts'
import { tr } from '@/systems/messages.client'

import { TriStateCheckbox } from './ui/tri-state-checkbox'

export default function PoolCheckboxes(props: { stores: PoolCheckboxesPrt.KeyProp }) {
	const checkboxes = Zus.useStore(props.stores.poolCheckboxes, PoolCheckboxesPrt.Sel.checkboxesState)

	return (
		<div data-tour="table-hide-repeats" className="flex items-center flex-nowrap whitespace-nowrap space-x-1">
			<TriStateCheckbox
				title={tr.text(F_Msgs.hideRepeatsHint())}
				size="sm"
				variant="ghost"
				onCheckedChange={(v) => {
					PoolCheckboxesPrt.Actions.setCheckbox(props.stores, 'dnr', invertApplyAs(v))
				}}
				checked={invertApplyAs(checkboxes.dnr)}
			>
				{tr.text(F_Msgs.hideRepeats())}
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
