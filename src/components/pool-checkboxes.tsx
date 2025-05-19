import * as QD from '@/systems.client/queue-dashboard.ts'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Checkbox } from './ui/checkbox.tsx'
import { Label } from './ui/label.tsx'

export default function PoolCheckboxes() {
	const [poolApplyAs, setPoolApplyAs] = Zus.useStore(QD.QDStore, useShallow(s => [s.poolApplyAs, s.setPoolApplyAs]))
	const dnrCheckboxId = React.useId()
	const filterCheckboxId = React.useId()

	return (
		<>
			<div className="flex items-center flex-nowrap space-x-0.5">
				<Label title="Hide layers which violate Do-Not-Repeat rules" htmlFor={dnrCheckboxId}>Hide Reruns</Label>
				<Checkbox
					id={dnrCheckboxId}
					onCheckedChange={v => {
						if (v === 'indeterminate') return
						setPoolApplyAs('dnr', v ? 'where-condition' : 'field')
					}}
					checked={poolApplyAs.dnr === 'where-condition'}
				/>
			</div>
			<div className="flex items-center flex-nowrap space-x-0.5">
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
