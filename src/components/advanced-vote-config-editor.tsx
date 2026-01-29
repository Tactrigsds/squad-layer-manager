import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import * as DH from '@/lib/display-helpers.ts'

import { BROADCASTS } from '@/messages.ts'
import type * as L from '@/models/layer'
import * as V from '@/models/vote.models.ts'
import * as ConfigClient from '@/systems/config.client'
import React from 'react'

export type AdvancedVoteConfigEditorProps = {
	config: Partial<V.AdvancedVoteConfig> | null
	choices: L.LayerId[]
	onChange: (config: Partial<V.AdvancedVoteConfig> | null) => void
	previewPlaceholder?: string
	includeResetToDefault?: boolean
	readonly?: boolean
}

export function AdvancedVoteConfigEditor(props: AdvancedVoteConfigEditorProps) {
	const appConfig = ConfigClient.useConfig()
	const displayProps = props.config?.displayProps ?? appConfig?.vote.voteDisplayProps ?? []
	const duration = props.config?.duration ?? appConfig?.vote.voteDuration ?? 120
	const usingDefault = !props.config?.displayProps && !props.config?.duration && !!appConfig?.vote.voteDisplayProps
	const statuses = DH.toDisplayPropStatuses(displayProps)

	const preview = props.choices.length > 0
		? BROADCASTS.vote.started(
			{ choiceIds: [], voterType: 'public' },
			props.choices,
			duration,
			displayProps,
		)
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
		<div className="grid gap-4">
			<div className="space-y-2">
				<h4 className="font-medium leading-none">Vote Display Options</h4>
				<p className="text-sm text-muted-foreground">
					Choose what info to show to voters
				</p>
			</div>
			<div className="grid gap-4">
				<div className="grid grid-cols-2 gap-4">
					<div className="space-y-2">
						<div className="grid gap-2">
							<div className="flex items-center space-x-2">
								<Checkbox
									id="layer"
									checked={statuses.layer}
									onCheckedChange={(checked) => setDisplayProps({ layer: checked === true })}
									disabled={props.readonly}
								/>
								<Label htmlFor="layer">Layer</Label>
							</div>
							<div className="ml-6 grid gap-2">
								<div className="flex items-center space-x-2">
									<Checkbox
										id="map"
										checked={statuses.map}
										onCheckedChange={(checked) => setDisplayProps({ map: checked === true })}
										disabled={props.readonly}
									/>
									<Label htmlFor="map">
										Map
									</Label>
								</div>
								<div className="flex items-center space-x-2">
									<Checkbox
										id="gamemode"
										checked={statuses.gamemode}
										onCheckedChange={(checked) => setDisplayProps({ gamemode: checked === true })}
										disabled={props.readonly}
									/>
									<Label htmlFor="gamemode">
										Gamemode
									</Label>
								</div>
							</div>
						</div>
					</div>
					<div className="space-y-2">
						<div className="grid gap-2">
							<div className="flex items-center space-x-2">
								<Checkbox
									id="factions"
									checked={statuses.factions}
									onCheckedChange={(checked) => setDisplayProps({ factions: checked === true })}
									disabled={props.readonly}
								/>
								<Label htmlFor="factions">Factions</Label>
							</div>
							<div className="flex items-center space-x-2">
								<Checkbox
									id="units"
									checked={statuses.units}
									onCheckedChange={(checked) => setDisplayProps({ units: checked === true })}
									disabled={props.readonly}
								/>
								<Label htmlFor="units">Units</Label>
							</div>
						</div>
					</div>
				</div>
				{!valid && (
					<div className="bg-destructive/10 border border-destructive rounded p-2">
						<p className="text-sm text-destructive">
							Warning: Can't distinguish between vote choices.
						</p>
					</div>
				)}
				<div className="space-y-2">
					<Label>Preview</Label>
					<pre
						style={{
							'fontFamily': `"Roboto Condensed", 'sans-serif'`,
							color: '#fcff00',
						}}
						className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap"
					>
						{preview}
					</pre>
				</div>
				<div className="space-y-2">
					<Label htmlFor="duration">Vote Duration (seconds)</Label>
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
					<Button
						variant="outline"
						size="sm"
						onClick={resetToDefault}
						disabled={usingDefault || props.readonly}
					>
						Reset to Default
					</Button>
				)}
			</div>
		</div>
	)
}
