import * as Icons from 'lucide-react'
import React from 'react'

import { AdvancedVoteConfigEditor } from '@/components/advanced-vote-config-editor'
import AppliedFiltersPanel from '@/components/applied-filters-panel.tsx'
import { StringEqConfig } from '@/components/filter-card'
import LayerFilterMenu from '@/components/layer-filter-menu'
import PoolCheckboxes from '@/components/pool-checkboxes.tsx'
import ShortLayerName from '@/components/short-layer-name'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
	HeadlessDialog,
	HeadlessDialogContent,
	HeadlessDialogDescription,
	HeadlessDialogHeader,
	HeadlessDialogTitle,
} from '@/components/ui/headless-dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as GenVoteFrame from '@/frames/gen-vote.frame'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Browser from '@/lib/browser'
import * as Obj from '@/lib/object-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as V_Msgs from '@/messages/vote.messages'
import * as F from '@/models/filter.models'
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
	// the tag control, rendered before Play Next / Play After
	tagsControl?: React.ReactNode
	onClose: () => void
	onSubmit: (result: GenVoteFrame.Result, cursor?: LL.Cursor) => void
}

/**
 * Same anatomy as before: the filters row, the constraint keys as include toggles with unique locks, Regenerate
 * All, the numbered choices, Add Choice, and the vote display options with Play Next / After and Submit. Choices
 * are rows rather than cards, and Show advanced reveals the picker's constraint menu above them. On a phone it is
 * one column with the filters behind a button and the submit block pinned to the bottom.
 */
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
	const phone = Browser.useIsSmallViewport()

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
		showAdvanced,
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
			showAdvanced: s.showAdvanced,
		})),
	)
	const constraintCount = Zus.useStore(
		frameKey,
		(s) => Object.values(s.filterMenu.menuItems).filter((c) => F.editableCompHasValue(c)).length,
	)

	// Track which items are being regenerated (undefined = all, number = specific index)
	const [requestedRegenIndex, setRegeneratingIndex] = React.useState<number | undefined | 'all'>()

	// Which choice is being manually edited via EditLayerDialog
	const [editingChoiceIndex, setEditingChoiceIndex] = React.useState<number>()
	const [filtersOpen, setFiltersOpen] = React.useState(false)

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
		if (config === null) {
			// full reset: Actions.setVoteConfig merges onto existing state, so clear it out first via replace
			Zus.resolveStore<GenVoteFrame.Types['state']>(frameKey).setState({ voteConfig: {} })
		} else {
			GenVoteFrame.Actions.setVoteConfig(genVoteStores, config)
		}
	}

	const hasChoices = choices.some((c) => c.layerId)
	const showAdvancedId = React.useId()

	const varyBy = (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="text-text-3 mr-0.5">{tr.text(V_Msgs.varyBy())}</span>
			{V.GenVote.CHOICE_COMPARISON_KEY.options.map((key) => {
				const included = includedConstraintKeys.includes(key)
				const unique = uniqueConstraintKeys.includes(key)
				return (
					<span key={key} className="fd-grp">
						<Button
							size="sm"
							variant={included ? 'default' : 'ghost'}
							data-state={included ? 'on' : 'off'}
							onClick={() => (included ? handleRemoveConstraint(key) : handleAddConstraint(key))}
						>
							{included ? <Icons.Minus /> : <Icons.Plus />}
							{key}
						</Button>
						<Button
							size="icon-sm"
							variant={unique ? 'primary' : 'ghost'}
							onClick={() => handleToggleUniqueConstraint(key)}
							disabled={!included}
							title={unique ? tr.text(V_Msgs.disableUnique()) : tr.text(V_Msgs.enableUnique())}
						>
							<Icons.Lock />
						</Button>
					</span>
				)
			})}
		</div>
	)
	const regenButton = (
		<Button
			size={phone ? 'default' : 'sm'}
			variant="primary"
			className={cn(phone && 'h-[34px]')}
			onClick={() => handleRegen()}
			disabled={generating}
		>
			<Icons.RefreshCw className={regeneratingIndex === 'all' ? 'animate-spin' : ''} />
			{hasChoices ? tr.text(V_Msgs.regenerateAll()) : tr.text(V_Msgs.generate())}
		</Button>
	)
	const choiceRows = (
		<ol className="fd-well list-none">
			{choices.map((choice, index) => {
				const constraints = choice.layerId ? chosenLayers[choice.layerId]?.constraints : undefined
				const error = choiceErrors[index]
				const layer = choice.layerId ? (
					<span className="flex items-center gap-2 min-w-0 whitespace-nowrap overflow-hidden">
						<ShortLayerName
							layerId={choice.layerId}
							matchDescriptors={constraints?.matchDescriptors}
							className={cn(phone && 'flex-col items-start')}
						/>
						{constraints && (
							<ConstraintEvalTooltip
								matchDescriptors={constraints.matchDescriptors}
								queriedConstraints={constraints.queriedConstraints}
								itemParity={teamParity}
								layerId={choice.layerId}
							/>
						)}
					</span>
				) : error ? (
					<Alert variant="destructive" className="py-1">
						<Icons.AlertCircle />
						<AlertTitle>{error}</AlertTitle>
					</Alert>
				) : (
					<span className="text-text-3">{tr.text(V_Msgs.noLayerSelected())}</span>
				)
				const constraintSelects = includedConstraintKeys.map((key) => (
					<span key={key} className="inline-flex items-center gap-1.5">
						<span className="text-xs text-text-2">{key}</span>
						<ChoiceConstraintSelect
							stores={genVoteStores}
							constraintKey={key}
							index={index}
							value={choice.choiceConstraints[key] as string | undefined}
						/>
					</span>
				))
				const actions = (
					<span className="fd-grp self-start">
						<Button
							size="icon-sm"
							onClick={() => setEditingChoiceIndex(index)}
							disabled={generating}
							title={tr.text(V_Msgs.editChoice())}
						>
							<Icons.Pencil />
						</Button>
						<Button
							size="icon-sm"
							onClick={() => handleRegen(index)}
							disabled={generating}
							title={choice.layerId ? tr.text(V_Msgs.regenerateChoice()) : tr.text(V_Msgs.generateChoice())}
						>
							<Icons.RefreshCw className={regeneratingIndex === 'all' || regeneratingIndex === index ? 'animate-spin' : ''} />
						</Button>
						<Button
							size="icon-sm"
							onClick={() => GenVoteFrame.Actions.removeChoice(genVoteStores, index)}
							disabled={generating || choices.length <= 2}
							title={tr.text(V_Msgs.removeChoice())}
						>
							<Icons.X />
						</Button>
					</span>
				)
				return (
					// choices are positional slots tracked by index across the component (regeneratingIndex,
					// editingChoiceIndex); regenerating a slot swaps its layerId but the slot identity is the index
					<li
						// oxlint-disable-next-line react/no-array-index-key
						key={`choice-${index}`}
						className={cn(
							'grid items-center gap-2.5 border-t border-[#1f1f21] first:border-t-0 px-2',
							phone
								? 'grid-cols-[22px_minmax(0,1fr)_auto] py-1.5 items-start'
								: 'grid-cols-[26px_minmax(0,1fr)_auto_auto] min-h-[calc(var(--row)+6px)]',
						)}
					>
						<span className="text-right font-mono text-text-3">{index + 1}.</span>
						{phone ? (
							<span className="flex min-w-0 flex-col gap-1">
								{layer}
								<span className="flex flex-wrap items-center gap-1.5">{constraintSelects}</span>
							</span>
						) : (
							<>
								{layer}
								<span className="flex items-center gap-2">{constraintSelects}</span>
							</>
						)}
						{actions}
					</li>
				)
			})}
		</ol>
	)
	const addChoice = (
		<Button
			size="sm"
			onClick={() => GenVoteFrame.Actions.addChoice(genVoteStores)}
			disabled={generating}
			title={tr.text(V_Msgs.addChoiceHint())}
		>
			<Icons.Plus />
			{tr.text(V_Msgs.addChoice())}
		</Button>
	)
	const modeSwitch = (
		<TabsList
			variant="seg"
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
	)
	const submitButton = (
		<Button variant="primary" size="sm" className={cn(phone && 'h-[34px] w-full')} onClick={handleSubmit} disabled={!canSubmit}>
			{tr.text(V_Msgs.submit())}
		</Button>
	)
	const configEditor = (
		<AdvancedVoteConfigEditor
			stores={{ squadServer: props.stores.squadServer }}
			config={voteConfig}
			choices={choices.map((c) => c.layerId).filter((id): id is string => !!id)}
			onChange={handleSetVoteConfig}
			previewPlaceholder="Generate layers to see vote preview"
			includeResetToDefault={false}
		/>
	)
	const advanced = (
		<div className="fd-well px-2.5 py-2">
			<div className="mb-1 flex items-center justify-between">
				<span className="fd-lbl-k">{tr.text(F_Msgs.constraints())}</span>
				<span className="text-xs text-text-3">{tr.text(V_Msgs.advancedBlurb())}</span>
			</div>
			<LayerFilterMenu
				stores={{ filterMenu: frameKey }}
				className="grid grid-cols-2 gap-x-4 [&>button:last-child]:col-span-2 [&>button:last-child]:justify-self-end"
			/>
		</div>
	)

	return (
		<>
			<HeadlessDialogContent
				className={cn('gap-0 p-0 overflow-hidden', !phone && 'max-h-[95vh] w-[1080px] max-w-[95vw]')}
				showCloseButton={false}
			>
				<HeadlessDialogHeader className="m-0 flex-nowrap items-center pr-2 gap-2">
					<HeadlessDialogTitle className="whitespace-nowrap">{props.title}</HeadlessDialogTitle>
					{props.description && (
						<HeadlessDialogDescription className="basis-auto truncate">· {props.description}</HeadlessDialogDescription>
					)}
					<span className="flex-1" />
					{!phone && <kbd className="fd-kbd">Esc</kbd>}
					<Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label={tr.text(UI_Msgs.close())}>
						<Icons.X />
					</Button>
				</HeadlessDialogHeader>
				{!phone && (
					<div className="flex items-center gap-2 min-h-[calc(var(--ctl)+6px)] px-2.5 border-b border-line shadow-[inset_0_1px_0_var(--line-soft)] overflow-x-auto whitespace-nowrap">
						<PoolCheckboxes stores={{ poolCheckboxes: frameKey }} />
						<span className="w-px h-4 bg-line shadow-[1px_0_0_var(--line-soft)]" />
						<AppliedFiltersPanel stores={{ squadServer: props.stores.squadServer, appliedFilters: frameKey }} />
						<span className="flex-1" />
						<span className="flex items-center gap-1.5">
							<Switch
								id={showAdvancedId}
								checked={showAdvanced}
								onCheckedChange={(v) => GenVoteFrame.Actions.setShowAdvanced(genVoteStores, v)}
							/>
							<Label htmlFor={showAdvancedId} className="fd-lbl-plain">
								{tr.text(V_Msgs.showAdvanced())}
							</Label>
						</span>
					</div>
				)}
				{!phone && (
					<div className="flex min-h-0 flex-1 gap-3 p-2.5 overflow-auto">
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<div className="flex items-center gap-1.5 whitespace-nowrap">
								{varyBy}
								<span className="flex-1" />
								{regenButton}
							</div>
							{showAdvanced && advanced}
							{choiceRows}
							{addChoice}
						</div>
						<div className="flex w-[300px] shrink-0 flex-col gap-2.5 border-l border-line pl-3 shadow-[-1px_0_0_var(--line-soft)]">
							{configEditor}
							<div className="flex-1" />
							<div className="flex items-center justify-end gap-2 whitespace-nowrap">
								{props.tagsControl}
								{modeSwitch}
								{submitButton}
							</div>
						</div>
					</div>
				)}
				{phone && (
					<>
						<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
							<div className="flex items-center gap-1.5 overflow-x-auto">
								<Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
									<Button className="h-[34px] shrink-0 px-3" onClick={() => setFiltersOpen(true)}>
										<Icons.Filter />
										{tr.text(F_Msgs.filtersButton())}
										{constraintCount > 0 && <span className="fd-chip">{constraintCount}</span>}
									</Button>
									<DialogContent>
										<DialogHeader>
											<DialogTitle>{tr.text(F_Msgs.filtersButton())}</DialogTitle>
										</DialogHeader>
										<div className="flex flex-col gap-2 flex-1 min-h-0 overflow-auto">
											<div className="flex flex-wrap items-center gap-1.5">
												<PoolCheckboxes stores={{ poolCheckboxes: frameKey }} />
												<AppliedFiltersPanel stores={{ squadServer: props.stores.squadServer, appliedFilters: frameKey }} />
											</div>
											<LayerFilterMenu stores={{ filterMenu: frameKey }} />
										</div>
										<DialogFooter>
											<Button variant="primary" size="sm" onClick={() => setFiltersOpen(false)}>
												{tr.text(UI_Msgs.done())}
											</Button>
										</DialogFooter>
									</DialogContent>
								</Dialog>
								<PoolCheckboxes stores={{ poolCheckboxes: frameKey }} />
							</div>
							{varyBy}
							{regenButton}
							{choiceRows}
							{addChoice}
							<div className="mt-1">{configEditor}</div>
						</div>
						<div className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-panel p-2 shadow-[inset_0_1px_0_var(--line-soft)]">
							<div className="flex items-center justify-between gap-2">
								{props.tagsControl}
								<span className="flex-1" />
								{modeSwitch}
							</div>
							{submitButton}
						</div>
					</>
				)}
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
			className="w-[120px]"
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
				tagsControl={props.tagsControl}
				onClose={onClose}
				onSubmit={props.onSubmit}
			/>
		</HeadlessDialog>
	)
}
