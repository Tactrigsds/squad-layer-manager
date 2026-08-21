import * as Icons from 'lucide-react'
import React from 'react'

import { AdvancedVoteConfigEditor } from '@/components/advanced-vote-config-editor'
import AppliedFiltersPanel from '@/components/applied-filters-panel.tsx'
import { StringEqConfig } from '@/components/filter-card'
import PoolCheckboxes from '@/components/pool-checkboxes.tsx'
import ShortLayerName from '@/components/short-layer-name'
import {
	HeadlessDialog,
	HeadlessDialogContent,
	HeadlessDialogDescription,
	HeadlessDialogHeader,
	HeadlessDialogTitle,
} from '@/components/ui/headless-dialog'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as GenVoteFrame from '@/frames/gen-vote.frame'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Obj from '@/lib/object-utils'
import * as Zus from '@/lib/zustand'
import * as V_Msgs from '@/messages/vote.messages'
import type * as L from '@/models/layer'
import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as V from '@/models/vote.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import { tr } from '@/systems/messages.client'

import { ConstraintEvalTooltip } from './constraint-matches-indicator'
import EditLayerDialog from './edit-layer-dialog'
import { Alert, AlertTitle } from './ui/alert'
import { Button } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import TabsList from './ui/tabs-list'

export type GenVoteDialogProps = Omit<GenVoteDialogContentProps, 'onClose'> & {
	open: boolean
	onOpenChange: (isOpen: boolean) => void
}

type GenVoteDialogContentProps = {
	title: string
	description?: React.ReactNode
	// FIXME stage4: GenVoteFrame.createInput now requires a `server` key to build a fresh gen-vote frame.
	// Callers that don't already have a `genVote` frame instance must also supply `stores.squadServer`.
	stores: Partial<GenVoteFrame.KeyProp> & SquadServerFrame.KeyProp
	cursor?: LL.Cursor
	onClose: () => void
	onSubmit: (result: GenVoteFrame.Result, cursor?: LL.Cursor) => void
}

const GenVoteDialogContent = React.memo<GenVoteDialogContentProps>(function GenVoteDialogContent(props) {
	const [frameInput] = React.useState(() => {
		if (props.stores.genVote) return undefined
		return GenVoteFrame.createInput({ cursor: props.cursor, server: props.stores.squadServer })
	})
	const frameKey = useFrameLifecycle(GenVoteFrame.frame, {
		frameKey: props.stores.genVote,
		input: frameInput,
		equalityFn: Obj.deepEqual,
	})
	// a frame this dialog provisioned itself dies with it; one handed in via stores belongs to its provider
	useFrameTeardownOnUnmount(frameKey, !props.stores.genVote)
	const genVoteStores: GenVoteFrame.KeyProp = React.useMemo(() => ({ genVote: frameKey }), [frameKey])

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
	} = Zus.useStore(
		frameKey,
		Zus.useShallow((s) => ({
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
	const [requestedRegenIndex, setRegeneratingIndex] = React.useState<number | undefined | 'all'>()

	// Which choice is being manually edited via EditLayerDialog
	const [editingChoiceIndex, setEditingChoiceIndex] = React.useState<number>()

	// the spinner it drives only means anything while a generation is in flight
	const regeneratingIndex = generating ? requestedRegenIndex : undefined
	const handleToggleUniqueConstraint = (key: V.GenVote.ChoiceConstraintKey) => {
		const state = Zus.getState(frameKey)
		if (state.uniqueConstraints.includes(key)) {
			GenVoteFrame.Actions.removeUniqueConstraint(genVoteStores, key)
		} else {
			GenVoteFrame.Actions.addUniqueConstraint(genVoteStores, key)
		}
	}

	const teamParity = Zus.useStore(
		LayerQueueClient.layerItemsState$(props.stores.squadServer.serverId),
		React.useCallback(
			(state: LQY.LayerItemsState) => {
				if (!cursor) return 0
				return LQY.resolveTeamParityForCursor(state, LQY.fromLayerListCursor(state, cursor))
			},
			[cursor],
		),
	)

	const handleSubmit = () => {
		const result = Zus.getState(frameKey).result
		const cursor = Zus.getState(frameKey).cursor
		if (!result) return
		props.onSubmit(result, cursor)
	}

	const handleEditedChoiceLayer = React.useCallback(
		(layerId: L.LayerId) => {
			if (editingChoiceIndex === undefined) return
			GenVoteFrame.Actions.setChoiceLayer(genVoteStores, editingChoiceIndex, layerId)
		},
		[editingChoiceIndex, genVoteStores],
	)

	const handleEditDialogOpenChange = React.useCallback((open: boolean) => {
		if (!open) setEditingChoiceIndex(undefined)
	}, [])

	const handleRegen = (choiceIndex?: number) => {
		setRegeneratingIndex(choiceIndex === undefined ? 'all' : choiceIndex)
		void GenVoteFrame.Actions.regen(genVoteStores, choiceIndex)
	}

	const handleAddConstraint = (key: V.GenVote.ChoiceConstraintKey) => {
		GenVoteFrame.Actions.addIncludedConstraint(genVoteStores, key)
	}

	const handleRemoveConstraint = (key: V.GenVote.ChoiceConstraintKey) => {
		GenVoteFrame.Actions.removeIncludedConstraint(genVoteStores, key)
	}

	const handleSetVoteConfig = (config: Partial<V.AdvancedVoteConfig> | null) => {
		console.log('setting config ', config)
		if (config === null) {
			// full reset: Actions.setVoteConfig merges onto existing state, so clear it out first via replace
			Zus.resolveStore<GenVoteFrame.Types['state']>(frameKey).setState({ voteConfig: {} })
		} else {
			GenVoteFrame.Actions.setVoteConfig(genVoteStores, config)
		}
	}

	return (
		<>
			{/*
				w-max sizes the dialog to the longest choice row, so it jumps between draws. The floor is the width that
				leaves the choices panel ~700px: 21rem for the config panel and its gap, 50px for p-6 and the border. Its
				95vw is the same term as max-w, so the floor can never outgrow the cap.
			*/}
			<HeadlessDialogContent className="max-h-[95vh] w-max min-w-[min(calc(700px_+_21rem_+_50px),95vw)] max-w-[95vw] flex flex-col overflow-auto">
				<HeadlessDialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
					<div className="flex items-center">
						<HeadlessDialogTitle>{props.title}</HeadlessDialogTitle>
						{props.description && <HeadlessDialogDescription>{props.description}</HeadlessDialogDescription>}
					</div>
					<div className="flex justify-end items-center space-x-2">
						<PoolCheckboxes stores={{ poolCheckboxes: frameKey }} />
						<AppliedFiltersPanel stores={{ squadServer: props.stores.squadServer, appliedFilters: frameKey }} />
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
										onClick={() =>
											includedConstraintKeys.includes(key) ? handleRemoveConstraint(key) : handleAddConstraint(key)
										}
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
						<Button size="sm" variant="default" onClick={() => handleRegen()} disabled={generating}>
							<Icons.RefreshCw className={regeneratingIndex === 'all' ? 'animate-spin' : ''} />
							{choices.some((c) => c.layerId) ? 'Regenerate All' : 'Generate'}
						</Button>
					</div>
					<div className="flex gap-4">
						<div className="flex flex-col gap-4 flex-1">
							<ol className="flex flex-col gap-4 list-none">
								{choices.map((choice, index) => {
									const constraints = choice.layerId ? chosenLayers[choice.layerId]?.constraints : undefined
									const error = choiceErrors[index]
									return (
										// choices are positional slots tracked by index across the component (regeneratingIndex,
										// editingChoiceIndex); regenerating a slot swaps its layerId but the slot identity is the index
										// oxlint-disable-next-line react/no-array-index-key
										<li key={`choice-${index}`} className="flex flex-col gap-2 p-4 border rounded-lg">
											<div className="flex items-center justify-between mb-2">
												<div className="flex items-center gap-2">
													<span className="font-semibold text-lg">{index + 1}.</span>
													<div>
														{choice.layerId ? (
															<div className="flex gap-1 items-center text-sm">
																<ShortLayerName layerId={choice.layerId} matchDescriptors={constraints?.matchDescriptors} />
																{constraints && (
																	<ConstraintEvalTooltip
																		matchDescriptors={constraints.matchDescriptors}
																		queriedConstraints={constraints.queriedConstraints}
																		itemParity={teamParity}
																		layerId={choice.layerId}
																	/>
																)}
															</div>
														) : error ? (
															<Alert variant="destructive" className="py-2">
																<Icons.AlertCircle className="h-4 w-4" />
																<AlertTitle>{error}</AlertTitle>
															</Alert>
														) : (
															<span className="text-muted-foreground">{tr.text(V_Msgs.noLayerSelected())}</span>
														)}
													</div>
												</div>
												<ButtonGroup>
													<Button
														size="sm"
														variant="ghost"
														onClick={() => setEditingChoiceIndex(index)}
														disabled={generating}
														title={tr.text(V_Msgs.editChoice())}
													>
														<Icons.Pencil />
													</Button>
													<Button
														size="sm"
														variant="ghost"
														onClick={() => handleRegen(index)}
														disabled={generating}
														title={choice.layerId ? tr.text(V_Msgs.regenerateChoice()) : tr.text(V_Msgs.generateChoice())}
													>
														<Icons.RefreshCw
															className={regeneratingIndex === 'all' || regeneratingIndex === index ? 'animate-spin' : ''}
														/>
													</Button>
													<Button
														size="sm"
														variant="ghost"
														onClick={() => GenVoteFrame.Actions.removeChoice(genVoteStores, index)}
														disabled={generating || choices.length <= 2}
														title={tr.text(V_Msgs.removeChoice())}
													>
														<Icons.X />
													</Button>
												</ButtonGroup>
											</div>
											<div className="flex flex-col gap-2">
												{includedConstraintKeys.map((key) => (
													<ChoiceConstraintSelect
														stores={genVoteStores}
														key={key}
														constraintKey={key}
														index={index}
														value={choice.choiceConstraints[key] as string | undefined}
													/>
												))}
											</div>
										</li>
									)
								})}
							</ol>
							<Button
								size="sm"
								variant="outline"
								onClick={() => GenVoteFrame.Actions.addChoice(genVoteStores)}
								disabled={generating}
								title={tr.text(V_Msgs.addChoiceHint())}
								className="w-full"
							>
								<Icons.Plus />
								{tr.text(V_Msgs.addChoice())}
							</Button>
						</div>
						<div className="w-80 shrink-0 flex flex-col justify-between">
							<AdvancedVoteConfigEditor
								stores={{ squadServer: props.stores.squadServer }}
								config={voteConfig}
								choices={choices.map((c) => c.layerId).filter((id): id is string => !!id)}
								onChange={handleSetVoteConfig}
								previewPlaceholder="Generate layers to see vote preview"
								includeResetToDefault={false}
							/>
							<div className="self-end flex gap-1">
								<TabsList
									options={[
										{ label: tr.text(V_Msgs.playNext()), value: 'next' },
										{ label: tr.text(V_Msgs.playAfter()), value: 'after' },
									]}
									active={cursor?.type === 'start' ? 'next' : 'after'}
									setActive={() => {
										const newCursor: LL.Cursor = cursor?.type === 'start' ? { type: 'end' } : { type: 'start' }
										GenVoteFrame.Actions.setCursor(genVoteStores, newCursor)
									}}
								/>
								<Button onClick={handleSubmit} disabled={!canSubmit}>
									{tr.text(V_Msgs.submit())}
								</Button>
							</div>
						</div>
					</div>
				</div>
			</HeadlessDialogContent>
			{/*
				Only mount while editing. EditLayerDialog is rendered as a sibling of this dialog rather than inside its
				content, so it does not inherit this dialog's BaseZIndexContext and both land on the same z-index.
				Stacking is therefore decided by DOM order in #headlessui-portal-root. EditLayerDialog uses
				unmount={false}, so if it were always mounted its portal wrapper would be pinned into the root before the
				gen-vote wrapper and paint behind it. Mounting it on open appends its wrapper last.
			*/}
			{editingChoiceIndex !== undefined && (
				<EditLayerDialog
					open
					onOpenChange={handleEditDialogOpenChange}
					layerId={choices[editingChoiceIndex]?.layerId}
					onSelectLayer={handleEditedChoiceLayer}
					cursor={cursor}
					stores={props.stores}
				/>
			)}
		</>
	)
})

function ChoiceConstraintSelect(props: {
	stores: GenVoteFrame.KeyProp & Partial<SquadServerFrame.KeyProp>
	constraintKey: V.GenVote.ChoiceConstraintKey
	index: number
	value: string | undefined
}) {
	const handleSetConstraint = (index: number, key: V.GenVote.ChoiceConstraintKey, value: string | null | undefined) => {
		GenVoteFrame.Actions.setChoiceConstraint(props.stores, index, key, value)
	}
	const column = props.constraintKey === 'Unit' ? 'Unit_1' : props.constraintKey

	const input = Zus.useStore(props.stores.genVote, props.stores.squadServer, Zus.useDeep(GenVoteFrame.Sel.baseQueryInput))
	const components = LayerQueriesClient.useLayerComponents({ ...input, column: column })
	const disallowedValues = Zus.useStore(
		props.stores.genVote,
		Zus.useShallow((s) => {
			let disallowedValues: string[] = []
			for (let i = 0; i < s.choices.length; i++) {
				if (i === props.index || !s.uniqueConstraints.includes(props.constraintKey)) continue
				const value = s.choices[i].choiceConstraints[props.constraintKey]
				if (value && typeof value === 'string') disallowedValues.push(value)
			}
			return disallowedValues
		}),
	)

	const allowedValues = Array.isArray(components.data) ? components.data.filter((v) => !disallowedValues.includes(v)) : undefined

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
	const onClose = () => {
		if (!onOpenChange) return
		onOpenChange(false)
	}

	return (
		<HeadlessDialog open={props.open} onOpenChange={onOpenChange} unmount={false}>
			<GenVoteDialogContent
				title={props.title}
				description={props.description}
				stores={props.stores}
				cursor={props.cursor}
				onClose={onClose}
				onSubmit={props.onSubmit}
			/>
		</HeadlessDialog>
	)
}
