import * as LQY from '@/models/layer-queries.models.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Checkbox } from './ui/checkbox.tsx'
import { Label } from './ui/label.tsx'

export default function PoolCheckboxes(
	props: {
		ephemeralState?: boolean
		defaultState?: QD.QDState['poolApplyAs']
	},
) {
	let poolApplyAs: QD.QDState['poolApplyAs']
	let setPoolApplyAs: (key: 'dnr' | 'filter', value: 'field' | 'where-condition') => void

	if (props.ephemeralState) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		const [_poolApplyAs, _setPoolApplyAs] = React.useState(props.defaultState!)
		poolApplyAs = _poolApplyAs
		setPoolApplyAs = (key, value) => {
			_setPoolApplyAs(state => ({ ...state, [key]: value }))
		}
	} else {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		;[poolApplyAs, setPoolApplyAs] = Zus.useStore(QD.QDStore, useShallow(s => [s.poolApplyAs, s.setPoolApplyAs]))
	}
	const dnrCheckboxId = React.useId()
	const filterCheckboxId = React.useId()

	return (
		<>
			<div className="flex items-center flex-nowrap whitespace-nowrap space-x-0.5">
				<Label title="Hide layers which violate Repeat rules" htmlFor={dnrCheckboxId}>Hide Repeats</Label>
				<Checkbox
					id={dnrCheckboxId}
					onCheckedChange={v => {
						if (v === 'indeterminate') return
						setPoolApplyAs('dnr', v ? 'where-condition' : 'field')
					}}
					checked={poolApplyAs.dnr === 'where-condition'}
				/>
			</div>
			<div className="flex items-center flex-nowrap space-x-0.5 whitespace-nowrap">
				<Label htmlFor={filterCheckboxId}>Hide Out-Of-Pool</Label>
				<Checkbox
					id={filterCheckboxId}
					onCheckedChange={v => {
						if (v === 'indeterminate') return
						setPoolApplyAs('filter', v ? 'where-condition' : 'field')
					}}
					checked={poolApplyAs.filter === 'where-condition'}
				/>
			</div>
		</>
	)
}
