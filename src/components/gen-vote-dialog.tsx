import { AdvancedVoteConfigEditor } from '@/components/advanced-vote-config-editor'
import AppliedFiltersPanel from '@/components/applied-filters-panel.tsx'
import { StringEqConfig } from '@/components/filter-card'
import PoolCheckboxes from '@/components/pool-checkboxes.tsx'
import ShortLayerName from '@/components/short-layer-name'
import { HeadlessDialog, HeadlessDialogContent, HeadlessDialogDescription, HeadlessDialogHeader, HeadlessDialogTitle } from '@/components/ui/headless-dialog'
import { getFrameState, useFrameLifecycle, useFrameStore } from '@/frames/frame-manager'
import * as GenVoteFrame from '@/frames/gen-vote.frame'

import * as Obj from '@/lib/object'
import { useRefConstructor } from '@/lib/react'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import * as ZusUtils from '@/lib/zustand'

import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as V from '@/models/vote.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as QD from '@/systems/queue-dashboard.client'
import * as Icons from 'lucide-react'
import React from 'react'
import { ConstraintMatchesIndicator } from './constraint-matches-indicator'

import { Alert, AlertTitle } from './ui/alert'
import { Button } from './ui/button'
import { ButtonGroup } from './ui/button-group'

export type GenVoteDialogProps = {
	title: string
	description?: React.ReactNode
	frames?: Partial<GenVoteFrame.KeyProp>
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	cursor?: LL.Cursor
	onSubmit(choices: GenVoteFrame.Result): void
}

type GenVoteDialogContentProps = {
	title: string
	description?: React.ReactNode
	frames?: Partial<GenVoteFrame.KeyProp>
	cursor?: LL.Cursor
	onClose: () => void
	onSubmit: (result: GenVoteFrame.Result) => void
}

const GenVoteDialogContent = React.memo<GenVoteDialogContentProps>(function GenVoteDialogContent(props) {
	const frameInputRef = useRefConstructor(() => {
		if (props.frames?.genVote) return undefined
		return GenVoteFrame.createInput({ cursor: props.cursor })
	})
	const frameKey = useFrameLifecycle(GenVoteFrame.frame, {
		frameKey: props.frames?.genVote,
		input: frameInputRef.current,
		deps: undefined,
		equalityFn: Obj.deepEqual,
	})

	const {
		choices,
		chosenLayers,
		choiceErrors,
		generating,
		result: canSubmit,
		cursor,
		includedConstraints: includedConstraintKeys,
		uniqueConstraints: uniqueConstraintKeys,
		voteConfig,
	} = useFrameStore(
		frameKey,
		ZusUtils.useShallow(s => ({
			choices: s.choices,
			chosenLayers: s.chosenLayers,
			choiceErrors: s.choiceErrors,
			generating: s.generating,
			result: s.result,
			cursor: s.cursor,
			includedConstraints: s.includedConstraints,
			uniqueConstraints: s.uniqueConstraints,
			voteConfig: s.voteConfig,
		})),
	)

	// Track which items are being regenerated (undefined = all, number = specific index)
	const [regeneratingIndex, setRegeneratingIndex] = React.useState<number | undefined | 'all'>()

	// Sync regenerating state
	React.useEffect(() => {
		if (!generating) {
			setRegeneratingIndex(undefined)
		}
	}, [generating])
	// const index = useFrameStore(frameKey, s => LQY.resolveCursorIndex(s.cursor)),
	const handleToggleUniqueConstraint = (key: V.GenVote.ChoiceConstraintKey) => {
		const state = getFrameState(frameKey)
		if (state.uniqueConstraints.includes(key)) {
			state.removeUniqueConstraint(key)
		} else {
			state.addUniqueConstraint(key)
		}
	}

	const teamParity = ReactRxHelpers.useStateObservableSelection(
		QD.layerItemsState$,
		React.useCallback((state) => {
			if (!cursor) return 0
			return LQY.resolveTeamParityForCursor(state, LQY.fromLayerListCursor(state, cursor))
		}, [cursor]),
	)

	const handleSubmit = () => {
		const result = getFrameState(frameKey).result
		if (!result) return
		props.onSubmit(result)
	}

	const handleRegen = (choiceIndex?: number) => {
		setRegeneratingIndex(choiceIndex === undefined ? 'all' : choiceIndex)
		void getFrameState(frameKey).regen(choiceIndex)
	}

	const handleAddConstraint = (key: V.GenVote.ChoiceConstraintKey) => {
		getFrameState(frameKey).addIncludedConstraint(key)
	}

	const handleRemoveConstraint = (key: V.GenVote.ChoiceConstraintKey) => {
		getFrameState(frameKey).removeIncludedConstraint(key)
	}

	const handleSetVoteConfig = (config: Partial<V.AdvancedVoteConfig> | null) => {
		console.log('setting config ', config)
		const state = getFrameState(frameKey)
		if (config === null) {
			state.setVoteConfig({})
		} else {
			state.setVoteConfig({ ...state.voteConfig, ...config })
		}
	}

	return (
		<HeadlessDialogContent className="max-h-[95vh] w-max max-w-[95vw] flex flex-col overflow-auto">
			<>
				<HeadlessDialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
					<div className="flex items-center">
						<HeadlessDialogTitle>{props.title}</HeadlessDialogTitle>
						{props.description && <HeadlessDialogDescription>{props.description}</HeadlessDialogDescription>}
					</div>
					<div className="flex justify-end items-center space-x-2">
						<PoolCheckboxes frameKey={frameKey} />
						<AppliedFiltersPanel frameKey={frameKey} />
					</div>
				</HeadlessDialogHeader>
				<div>
					<div className="flex gap-1 justify-between">
						<div className="flex gap-1">
							{V.GenVote.CHOICE_COMPARISON_KEY.options.map((key) => (
								<ButtonGroup key={key}>
									<Button
										size="sm"
										variant={includedConstraintKeys.includes(key) ? 'secondary' : 'ghost'}
										onClick={() => includedConstraintKeys.includes(key) ? handleRemoveConstraint(key) : handleAddConstraint(key)}
									>
										{includedConstraintKeys.includes(key) ? <Icons.Minus /> : <Icons.Plus />}
										{key}
									</Button>
									<Button
										size="icon"
										variant={uniqueConstraintKeys.includes(key) ? 'default' : 'ghost'}
										onClick={() => handleToggleUniqueConstraint(key)}
										disabled={!includedConstraintKeys.includes(key)}
										title={uniqueConstraintKeys.includes(key) ? 'Disable unique constraint' : 'Enable unique constraint'}
									>
										<Icons.Lock className="w-4 h-4" />
									</Button>
								</ButtonGroup>
							))}
						</div>
						<Button
							size="sm"
							variant="default"
							onClick={() => handleRegen()}
							disabled={generating}
						>
							<Icons.RefreshCw className={regeneratingIndex === 'all' ? 'animate-spin' : ''} />
							{choices.some(c => c.layerId) ? 'Regenerate All' : 'Generate'}
						</Button>
					</div>
					<div className="flex gap-4">
						<div className="flex flex-col gap-4 flex-1">
							{choices.map((choice, index) => {
								const constraints = choice.layerId ? chosenLayers[choice.layerId]?.constraints : undefined
								const error = choiceErrors[index]
								return (
									<div key={`choice-${index}`} className="flex flex-col gap-2 p-4 border rounded-lg">
										<div className="flex items-center justify-between mb-2">
											<div className="flex items-center gap-2">
												<span className="font-semibold text-lg">{index + 1}.</span>
												<div>
													{choice.layerId
														? (
															<div className="flex gap-1 items-center text-sm">
																<ShortLayerName
																	layerId={choice.layerId}
																	matchDescriptors={constraints?.matchDescriptors}
																/>
																{constraints && (
																	<ConstraintMatchesIndicator
																		matchingConstraintIds={constraints.matchedConstraintIds}
																		matchDescriptors={constraints.matchDescriptors}
																		queriedConstraints={constraints.queriedConstraints}
																		itemParity={teamParity}
																		layerId={choice.layerId}
																	/>
																)}
															</div>
														)
														: error
														? (
															<Alert variant="destructive" className="py-2">
																<Icons.AlertCircle className="h-4 w-4" />
																<AlertTitle>{error}</AlertTitle>
															</Alert>
														)
														: <span className="text-muted-foreground">No layer selected</span>}
												</div>
											</div>
											<ButtonGroup>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => handleRegen(index)}
													disabled={generating}
													title={choice.layerId ? 'Regenerate this choice' : 'Generate this choice'}
												>
													<Icons.RefreshCw className={regeneratingIndex === 'all' || regeneratingIndex === index ? 'animate-spin' : ''} />
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => getFrameState(frameKey).removeChoice(index)}
													disabled={generating || choices.length <= 2}
													title="Remove this choice (minimum 2 required)"
												>
													<Icons.X />
												</Button>
											</ButtonGroup>
										</div>
										<div className="flex flex-col gap-2">
											{includedConstraintKeys.map((key) => (
												<ChoiceConstraintSelect
													frameKey={frameKey}
													key={key}
													constraintKey={key}
													index={index}
													value={choice.choiceConstraints[key] as string | undefined}
												/>
											))}
										</div>
									</div>
								)
							})}
							<Button
								size="sm"
								variant="outline"
								onClick={() => getFrameState(frameKey).addChoice()}
								disabled={generating}
								title="Add choice"
								className="w-full"
							>
								<Icons.Plus />
								Add Choice
							</Button>
						</div>
						<div className="w-80 shrink-0 flex flex-col justify-between">
							<AdvancedVoteConfigEditor
								config={voteConfig}
								choices={choices.map(c => c.layerId).filter((id): id is string => !!id)}
								onChange={handleSetVoteConfig}
								previewPlaceholder="Generate layers to see vote preview"
								includeResetToDefault={false}
							/>
							<div className="self-end">
								<Button variant="outline" onClick={props.onClose} className="self-end">
									Cancel
								</Button>
								<Button onClick={handleSubmit} disabled={!canSubmit}>
									Submit
								</Button>
							</div>
						</div>
					</div>
				</div>
			</>
		</HeadlessDialogContent>
	)
})

function ChoiceConstraintSelect(
	props: { frameKey: GenVoteFrame.Key; constraintKey: V.GenVote.ChoiceConstraintKey; index: number; value: string | undefined },
) {
	const handleSetConstraint = (index: number, key: V.GenVote.ChoiceConstraintKey, value: string | null | undefined) => {
		getFrameState(props.frameKey).setChoiceConstraint(index, key, value)
	}
	const column = props.constraintKey === 'Unit' ? 'Unit_1' : props.constraintKey
	const input = useFrameStore(props.frameKey, ZusUtils.useDeep(GenVoteFrame.selectBaseQueryInput))
	const components = LayerQueriesClient.useLayerComponents({ ...input, column: column })
	const disallowedValues = useFrameStore(
		props.frameKey,
		ZusUtils.useShallow(s => {
			let disallowedValues: string[] = []
			for (let i = 0; i < s.choices.length; i++) {
				if (i === props.index || !s.uniqueConstraints.includes(props.constraintKey)) continue
				const value = s.choices[i].choiceConstraints[props.constraintKey]
				if (value && typeof value === 'string') disallowedValues.push(value)
			}
			return disallowedValues
		}),
	)

	const allowedValues = Array.isArray(components.data) ? components.data.filter(v => !disallowedValues.includes(v)) : undefined

	return (
		<StringEqConfig
			key={props.constraintKey}
			column={column}
			allowedValues={allowedValues}
			value={props.value}
			setValue={(value) => handleSetConstraint(props.index, props.constraintKey, value)}
		/>
	)
}

export default function GenVoteDialog(props: GenVoteDialogProps) {
	const onOpenChange = props.onOpenChange
	const onClose = React.useCallback(() => {
		if (!onOpenChange) return
		onOpenChange(false)
	}, [onOpenChange])

	return (
		<HeadlessDialog open={props.open} onOpenChange={onOpenChange} unmount={false}>
			<GenVoteDialogContent
				title={props.title}
				description={props.description}
				frames={props.frames}
				cursor={props.cursor}
				onClose={onClose}
				onSubmit={props.onSubmit}
			/>
		</HeadlessDialog>
	)
}
