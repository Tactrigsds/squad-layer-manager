import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object'
import { BROADCASTS } from '@/messages.ts'
import * as L from '@/models/layer'
import * as V from '@/models/vote.models.ts'
import * as ConfigClient from '@/systems/config.client'
import React from 'react'

export type VoteDisplayConfigProps = {
	displayProps?: DH.LayerDisplayProp[]
	choices: L.LayerId[]
	onChange: (displayProps: DH.LayerDisplayProp[] | null) => void
	previewPlaceholder?: string
}

export function VoteDisplayConfig(props: VoteDisplayConfigProps) {
	const config = ConfigClient.useConfig()
	const displayProps = props.displayProps ?? config?.vote.voteDisplayProps ?? []
	const usingDefault = !props.displayProps && !!config?.vote.voteDisplayProps
	const statuses = DH.toDisplayPropStatuses(displayProps)

	const preview = props.choices.length > 0
		? BROADCASTS.vote.started(
			{ choices: props.choices, voterType: 'public' },
			config?.vote.voteDuration ?? 120,
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

		if (config && Obj.deepEqual(updated, DH.toDisplayPropStatuses(config.vote.voteDisplayProps))) {
			props.onChange(null)
		} else {
			props.onChange(DH.fromDisplayPropStatuses(updated))
		}
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
								/>
								<Label htmlFor="layer">Layer</Label>
							</div>
							<div className="ml-6 grid gap-2">
								<div className="flex items-center space-x-2">
									<Checkbox
										id="map"
										checked={statuses.map}
										onCheckedChange={(checked) => setDisplayProps({ map: checked === true })}
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
								/>
								<Label htmlFor="factions">Factions</Label>
							</div>
							<div className="flex items-center space-x-2">
								<Checkbox
									id="units"
									checked={statuses.units}
									onCheckedChange={(checked) => setDisplayProps({ units: checked === true })}
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
					<pre className="font-mono text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap">
						{preview}
					</pre>
				</div>
				<Separator />
				<Button
					variant="outline"
					size="sm"
					onClick={resetToDefault}
					disabled={usingDefault}
				>
					Reset to Defaults
				</Button>
			</div>
		</div>
	)
}
