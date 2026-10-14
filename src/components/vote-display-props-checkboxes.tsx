import React from 'react'

import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import * as V_Msgs from '@/messages/vote.messages'
import * as DH from '@/models/display-helpers.models'
import { tr } from '@/systems/messages.client'

export type VoteDisplayPropsCheckboxesProps = {
	displayProps: DH.LayerDisplayProp[]
	onChange: (displayProps: DH.LayerDisplayProp[]) => void
	disabled?: boolean
	// keeps the map shown, for votes whose choices are only certain to differ by map
	lockMap?: boolean
}

export function VoteDisplayPropsCheckboxes(props: VoteDisplayPropsCheckboxesProps) {
	const idPrefix = React.useId()
	const statuses = DH.toDisplayPropStatuses(props.displayProps)
	if (props.lockMap) statuses.map = true

	function setDisplayProps(update: Partial<DH.LayerDisplayPropsStatuses>) {
		const updated = { ...statuses, ...update }
		if (update.layer) {
			updated.map = true
			updated.gamemode = true
		} else if (update.layer === false) {
			updated.map = false
			updated.gamemode = false
		} else if (update.gamemode === false || update.map === false) {
			updated.layer = false
		}
		if (props.lockMap) updated.map = true
		props.onChange(DH.fromDisplayPropStatuses(updated))
	}

	function row(prop: DH.LayerDisplayProp, label: string, disabled?: boolean) {
		const id = `${idPrefix}-${prop}`
		return (
			<div className="flex items-center gap-1.5">
				<Checkbox
					id={id}
					checked={statuses[prop]}
					onCheckedChange={(checked) => setDisplayProps({ [prop]: checked })}
					disabled={props.disabled || disabled}
				/>
				<Label htmlFor={id} className="fd-lbl-plain">
					{label}
				</Label>
			</div>
		)
	}

	return (
		<div className="grid grid-cols-2 gap-x-3 gap-y-1">
			<div className="grid gap-1 content-start">
				{row('layer', tr.text(V_Msgs.displayLayer()))}
				<div className="ms-[18px] grid gap-1">
					{row('map', tr.text(V_Msgs.displayMap()), props.lockMap)}
					{row('gamemode', tr.text(V_Msgs.displayGamemode()))}
				</div>
			</div>
			<div className="grid gap-1 content-start">
				{row('factions', tr.text(V_Msgs.displayFactions()))}
				{row('units', tr.text(V_Msgs.displayUnits()))}
			</div>
		</div>
	)
}
