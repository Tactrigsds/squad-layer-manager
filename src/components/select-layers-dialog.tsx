import React from 'react'

import { Button } from '@/components/ui/button'
import { HeadlessDialog } from '@/components/ui/headless-dialog'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Browser from '@/lib/browser'
import * as Obj from '@/lib/object-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'
import { tr } from '@/systems/messages.client'
import { useLoggedInUser } from '@/systems/users.client'

import LayerPickerLayout from './layer-picker-layout.tsx'
import TabsList from './ui/tabs-list.tsx'

type SelectMode = 'vote' | 'layers'

type SelectLayersDialogProps = {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	selectQueueItems?: (queueItems: LL.NewItem[]) => void
	defaultSelected?: L.LayerId[]
	stores?: Partial<SelectLayersFrame.KeyProp & SquadServerFrame.KeyProp>
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	// rendered beside the vote/set-layer switch, e.g. the play next / play after switch
	modeSwitchAdditions?: React.ReactNode
	// rendered in the submit block above the mode switch and Submit, e.g. the tags to apply
	footerBeforeSubmit?: React.ReactNode
	cursor?: LL.Cursor
}

type SelectLayersDialogContentProps = {
	title: string
	description?: React.ReactNode
	pinMode?: SelectMode
	selectQueueItems?: (queueItems: LL.NewItem[]) => void
	defaultSelected: L.LayerId[]
	stores?: Partial<SelectLayersFrame.KeyProp & SquadServerFrame.KeyProp>
	modeSwitchAdditions?: React.ReactNode
	footerBeforeSubmit?: React.ReactNode
	cursor?: LL.Cursor
	onClose: () => void
}

const SelectLayersDialogContent = React.memo<SelectLayersDialogContentProps>(function SelectLayersDialogContent(props) {
	const [frameInput] = React.useState(() => {
		if (props.stores?.selectLayers) return undefined
		return SelectLayersFrame.createInput({ cursor: props.cursor })
	})
	const frameKey = useFrameLifecycle(SelectLayersFrame.frame, {
		frameKey: props.stores?.selectLayers,
		input: frameInput,
		equalityFn: Obj.deepEqual,
	})
	// a frame this dialog provisioned itself dies with it; one handed in via stores belongs to its provider
	useFrameTeardownOnUnmount(frameKey, !props.stores?.selectLayers)

	const [selectMode, _setSelectMode] = React.useState<SelectMode>(props.pinMode ?? 'layers')
	const setSelectedLayers = React.useCallback(
		(update: React.SetStateAction<L.LayerId[]>) => LayerTablePrt.Actions.setSelected({ layerTable: frameKey }, update),
		[frameKey],
	)

	function setAdditionType(newAdditionType: SelectMode) {
		if (newAdditionType === 'vote') {
			setSelectedLayers((prev) => {
				const seenIds = new Set<string>()
				return prev.filter((layerId) => {
					if (seenIds.has(layerId)) {
						return false
					}
					seenIds.add(layerId)
					return true
				})
			})
		}
		_setSelectMode(newAdditionType)
	}

	const user = useLoggedInUser()
	const phone = Browser.useIsSmallViewport()

	const selectedCount = Zus.useStore(frameKey, (s) => s.layerTable.selected.length)
	const canSubmit = selectedCount > 0

	const submit = props.selectQueueItems
		? () => {
				if (!canSubmit) return
				const selectedLayers = Zus.getState(frameKey).layerTable.selected
				const source: LL.Source = { type: 'manual', userId: user!.discordId }
				if (selectMode === 'layers' || selectedLayers.length === 1) {
					const items: LL.NewSingleItem[] = selectedLayers.map((layerId) => ({ type: 'single-list-item', layerId }))
					props.selectQueueItems!(items)
				} else if (selectMode === 'vote') {
					const item: LL.NewVoteItem = {
						type: 'vote-list-item',
						layerId: selectedLayers[0],
						choices: selectedLayers.map((layerId) => LL.createItem({ type: 'single-list-item', layerId }, source)),
					}
					props.selectQueueItems!([item])
				}
				props.onClose()
			}
		: undefined

	// Reset selected layers when component mounts or default selection changes
	React.useEffect(() => {
		setSelectedLayers(props.defaultSelected)
	}, [props.defaultSelected, setSelectedLayers])

	const modeSwitch = !props.pinMode && (
		<TabsList
			variant="seg"
			options={[
				{ label: tr.text(L_Msgs.voteMode()), value: 'vote' },
				{ label: tr.text(L_Msgs.setLayerMode()), value: 'layers' },
			]}
			active={selectMode}
			setActive={setAdditionType}
		/>
	)
	const submitButton = submit && (
		<Button data-tour="add-submit" variant="primary" size="sm" disabled={!canSubmit} onClick={submit} className={cn(phone && 'w-full')}>
			{phone && selectedCount > 0 ? tr.text(L_Msgs.submitCount(selectedCount)) : tr.text(L_Msgs.submit())}
		</Button>
	)

	const footer = phone ? (
		<>
			<div className="flex items-center gap-2 overflow-x-auto">
				{props.footerBeforeSubmit}
				<span className="flex-1" />
				{props.modeSwitchAdditions}
				{modeSwitch}
			</div>
			{submitButton}
		</>
	) : (
		<>
			{props.footerBeforeSubmit && <div className="flex flex-wrap items-center gap-1 whitespace-nowrap">{props.footerBeforeSubmit}</div>}
			<div className="flex flex-wrap items-center justify-between gap-1.5">
				{props.modeSwitchAdditions}
				{modeSwitch}
				{submitButton}
			</div>
		</>
	)

	return (
		<LayerPickerLayout
			frameKey={frameKey}
			squadServer={props.stores?.squadServer}
			title={props.title}
			description={props.description}
			tourPrefix="add"
			canToggleColumns
			footer={footer}
			onClose={props.onClose}
		/>
	)
})

const NO_LAYERS: L.LayerId[] = []

export default function SelectLayersDialog(props: SelectLayersDialogProps) {
	const defaultSelected = props.defaultSelected ?? NO_LAYERS

	const onOpenChange = props.onOpenChange
	const onClose = () => {
		if (!onOpenChange) return
		onOpenChange(false)
	}

	return (
		<HeadlessDialog open={props.open} onOpenChange={onOpenChange} unmount={false}>
			{props.open && (
				<SelectLayersDialogContent
					title={props.title}
					description={props.description}
					pinMode={props.pinMode}
					selectQueueItems={props.selectQueueItems}
					defaultSelected={defaultSelected}
					stores={props.stores}
					modeSwitchAdditions={props.modeSwitchAdditions}
					footerBeforeSubmit={props.footerBeforeSubmit}
					cursor={props.cursor}
					onClose={onClose}
				/>
			)}
		</HeadlessDialog>
	)
}
