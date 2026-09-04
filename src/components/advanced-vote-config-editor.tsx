import React from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as DH from '@/lib/display-helpers.ts'
import * as Zus from '@/lib/zustand'
import * as V_Msgs from '@/messages/vote.messages'
import type * as L from '@/models/layer'
import * as V from '@/models/vote.models.ts'
import { tr } from '@/systems/messages.client'

export type AdvancedVoteConfigEditorProps = {
	// vote defaults are per-server, so the editor needs the server whose defaults it is filling in
	stores: SquadServerFrame.KeyProp
	config: Partial<V.AdvancedVoteConfig> | null
	choices: L.LayerId[]
	onChange: (config: Partial<V.AdvancedVoteConfig> | null) => void
	previewPlaceholder?: string
	includeResetToDefault?: boolean
	readonly?: boolean
}

export function AdvancedVoteConfigEditor(props: AdvancedVoteConfigEditorProps) {
	const voteDefaults = Zus.useStore(props.stores.squadServer, (s) => SquadServerFrame.Sel.settings(s).vote)
	const displayProps = props.config?.displayProps ?? voteDefaults.voteDisplayProps
	const duration = props.config?.duration ?? voteDefaults.voteDuration
	const usingDefault = !props.config?.displayProps && !props.config?.duration
	const statuses = DH.toDisplayPropStatuses(displayProps)

	const preview =
		props.choices.length > 0
			? tr.richText(V_Msgs.started({ choiceIds: [], voterType: 'public' }, props.choices, duration, displayProps))
			: (props.previewPlaceholder ?? 'No layers selected for preview')
	const valid = props.choices.length > 0 ? V.validateChoicesWithDisplayProps(props.choices, displayProps) : true

	function setDisplayProps(update: Partial<DH.LayerDisplayPropsStatuses>) {
		update = { ...update }

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

		const displayPropsValue = DH.fromDisplayPropStatuses(updated)
		const configToPass: Partial<V.AdvancedVoteConfig> = {
			...props.config,
			displayProps: displayPropsValue,
		}

		props.onChange(configToPass)
	}

	function setDuration(newDuration: number) {
		const configToPass: Partial<V.AdvancedVoteConfig> = {
			...props.config,
			duration: newDuration,
		}

		props.onChange(configToPass)
	}

	function resetToDefault() {
		if (usingDefault) return
		props.onChange(null)
	}

	return (
		<div className="grid gap-2.5">
			<div>
				<h4 className="fd-cond font-bold text-base">{tr.text(V_Msgs.displayOptionsHeading())}</h4>
				<p className="text-xs text-text-3">{tr.text(V_Msgs.displayOptionsBlurb())}</p>
			</div>
			<div className="grid gap-2.5">
				<div className="grid grid-cols-2 gap-x-3 gap-y-1">
					<div>
						<div className="grid gap-1">
							<div className="flex items-center gap-1.5">
								<Checkbox
									id="layer"
									checked={statuses.layer}
									onCheckedChange={(checked) => setDisplayProps({ layer: checked === true })}
									disabled={props.readonly}
								/>
								<Label htmlFor="layer" className="fd-lbl-plain">
									{tr.text(V_Msgs.displayLayer())}
								</Label>
							</div>
							<div className="ml-[18px] grid gap-1">
								<div className="flex items-center gap-1.5">
									<Checkbox
										id="map"
										checked={statuses.map}
										onCheckedChange={(checked) => setDisplayProps({ map: checked === true })}
										disabled={props.readonly}
									/>
									<Label htmlFor="map" className="fd-lbl-plain">
										{tr.text(V_Msgs.displayMap())}
									</Label>
								</div>
								<div className="flex items-center gap-1.5">
									<Checkbox
										id="gamemode"
										checked={statuses.gamemode}
										onCheckedChange={(checked) => setDisplayProps({ gamemode: checked === true })}
										disabled={props.readonly}
									/>
									<Label htmlFor="gamemode" className="fd-lbl-plain">
										{tr.text(V_Msgs.displayGamemode())}
									</Label>
								</div>
							</div>
						</div>
					</div>
					<div>
						<div className="grid gap-1">
							<div className="flex items-center gap-1.5">
								<Checkbox
									id="factions"
									checked={statuses.factions}
									onCheckedChange={(checked) => setDisplayProps({ factions: checked === true })}
									disabled={props.readonly}
								/>
								<Label htmlFor="factions" className="fd-lbl-plain">
									{tr.text(V_Msgs.displayFactions())}
								</Label>
							</div>
							<div className="flex items-center gap-1.5">
								<Checkbox
									id="units"
									checked={statuses.units}
									onCheckedChange={(checked) => setDisplayProps({ units: checked === true })}
									disabled={props.readonly}
								/>
								<Label htmlFor="units" className="fd-lbl-plain">
									{tr.text(V_Msgs.displayUnits())}
								</Label>
							</div>
						</div>
					</div>
				</div>
				{!valid && (
					<div className="fd-alert fd-alert-dng grid-cols-1">
						<p className="text-xs">{tr.text(V_Msgs.choicesIndistinguishable())}</p>
					</div>
				)}
				<div className="fd-fld">
					<Label>{tr.text(V_Msgs.previewLabel())}</Label>
					<pre
						style={{ color: props.choices.length > 0 ? '#fcff00' : undefined }}
						className="fd-well fd-cond m-0 px-2 py-1.5 text-xs leading-[1.35] text-text-3 overflow-x-auto whitespace-pre-wrap"
					>
						{preview}
					</pre>
				</div>
				<div className="fd-fld">
					<Label htmlFor="duration">{tr.text(V_Msgs.durationLabel())}</Label>
					<Input
						id="duration"
						type="number"
						min="1"
						value={(duration / 1000).toFixed(0)}
						onChange={(e) => setDuration(Math.max(1000, parseInt(e.target.value) * 1000 || 1000))}
						className="w-full"
						disabled={props.readonly}
					/>
				</div>
				{(props.includeResetToDefault ?? true) && (
					<Button variant="outline" size="sm" onClick={resetToDefault} disabled={usingDefault || props.readonly}>
						{tr.text(V_Msgs.resetToDefault())}
					</Button>
				)}
			</div>
		</div>
	)
}
