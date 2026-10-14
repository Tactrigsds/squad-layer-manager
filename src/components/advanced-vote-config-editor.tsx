import React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { VoteDisplayPropsCheckboxes } from '@/components/vote-display-props-checkboxes'
import * as ListHostPrt from '@/frame-partials/list-host.partial'
import * as Zus from '@/lib/zustand'
import * as V_Msgs from '@/messages/vote.messages'
import type * as DH from '@/models/display-helpers.models'
import type * as L from '@/models/layer.models'
import * as V from '@/models/vote.models.ts'
import { tr } from '@/systems/messages.client'

export type AdvancedVoteConfigEditorProps = {
	// vote defaults are per-server, so the editor needs the server whose defaults it is filling in
	stores: ListHostPrt.KeyProp
	config: Partial<V.AdvancedVoteConfig> | null
	choices: L.LayerId[]
	onChange: (config: Partial<V.AdvancedVoteConfig> | null) => void
	previewPlaceholder?: string
	includeResetToDefault?: boolean
	readonly?: boolean
}

export function AdvancedVoteConfigEditor(props: AdvancedVoteConfigEditorProps) {
	const voteDefaults = Zus.useStore(props.stores.listHost, (s) => ListHostPrt.Sel.settings(s).vote)
	const displayProps = props.config?.displayProps ?? voteDefaults.voteDisplayProps
	const duration = props.config?.duration ?? voteDefaults.voteDuration
	const usingDefault = !props.config?.displayProps && !props.config?.duration

	const preview =
		props.choices.length > 0
			? tr.richText(V_Msgs.started({ choiceIds: [], voterType: 'public' }, props.choices, duration, displayProps))
			: (props.previewPlaceholder ?? 'No layers selected for preview')
	const valid = props.choices.length > 0 ? V.validateChoicesWithDisplayProps(props.choices, displayProps) : true

	function setDisplayProps(displayProps: DH.LayerDisplayProp[]) {
		props.onChange({ ...props.config, displayProps })
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
				<VoteDisplayPropsCheckboxes displayProps={displayProps} onChange={setDisplayProps} disabled={props.readonly} />
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
