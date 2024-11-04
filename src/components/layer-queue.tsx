import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { produce } from 'immer'
import * as diffpatch from 'jsondiffpatch'
import { EllipsisVertical, GripVertical, PlusIcon } from 'lucide-react'
import { createContext, useRef, useState } from 'react'
import React from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip.tsx'
import { useNowPlayingState as useCurrentLayer } from '@/hooks/server-state.ts'
import { useToast } from '@/hooks/use-toast'
import * as Helpers from '@/lib/display-helpers'
import { trpcReact } from '@/lib/trpc.client.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import * as M from '@/models'

import AddLayerPopover from './add-layer-popover'
import ComboBox from './combo-box/combo-box.tsx'
import { LOADING } from './combo-box/constants.ts'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { useAlertDialog } from './ui/lazy-alert-dialog.tsx'
import { ScrollArea } from './ui/scroll-area.tsx'
import { Separator } from './ui/separator'
import { TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'
import VoteTallyDisplay from './votes-display.tsx'

const LayerQueueContext = createContext<object>({})

export default function LayerQueue() {
	const [layerQueue, setLayerQueue] = useState(null as null | M.LayerQueue)
	const currentLayer = useCurrentLayer()
	const [poolFilterId, setPoolFilterId] = useState(null as M.ServerState['poolFilterId'])

	const [serverState, setServerState] = useState(null as null | (M.ServerState & M.UserPart))
	const layerQueueSeqIdRef = useRef(-1)
	const poolFilterEdited = !!serverState && serverState.poolFilterId !== poolFilterId
	function updatePoolFilter(filterId: M.ServerState['poolFilterId']) {
		setPoolFilterId(filterId)
	}
	const queueDiff: diffpatch.ArrayDelta | undefined =
		serverState && layerQueue ? (differ.diff(serverState.layerQueue, layerQueue) as diffpatch.ArrayDelta) : undefined
	const editing = !!queueDiff

	trpcReact.server.watchServerState.useSubscription(undefined, {
		onData: (data) => {
			setLayerQueue(data.layerQueue)
			setPoolFilterId(data.poolFilterId)
			setServerState(data)
			layerQueueSeqIdRef.current = data.layerQueueSeqId
		},
	})
	const abortVoteMutation = trpcReact.server.abortVote.useMutation()
	const startVoteMutation = trpcReact.server.startVote.useMutation()

	const toaster = useToast()
	const updateQueueMutation = trpcReact.server.updateQueue.useMutation()
	async function saveLayers() {
		if (!editing || !layerQueue || !serverState) return
		const res = await updateQueueMutation.mutateAsync({
			queue: layerQueue,
			seqId: layerQueueSeqIdRef.current,
		})
		if (res.code === 'err:next-layer-changed-while-vote-active') {
			toaster.toast({
				title: 'Cannot update next layer: active layer vote in progress',
				variant: 'destructive',
			})
			return
		}
		if (res.code === 'err:out-of-sync') {
			toaster.toast({ title: 'Queue state changed before submission, please try again.', variant: 'destructive' })
			return
		}
		if (res.code === 'ok') {
			toaster.toast({ title: 'Updated next layer on game server' })
			return
		}
	}

	function reset() {
		if (!editing || !layerQueue || !serverState) return
		setLayerQueue(serverState.layerQueue)
	}

	function handleDragEnd(event: DragEndEvent) {
		if (!event.over) return
		const sourceIndex = getIndexFromQueueItemId(event.active.id as string)
		const targetIndex = getIndexFromQueueItemId(event.over.id as string)
		if (sourceIndex === targetIndex || targetIndex + 1 === sourceIndex) return
		setLayerQueue(
			produce((draft) => {
				let insertIndex = targetIndex + 1
				if (!draft) throw new Error('layerQueue is null')
				const [removed] = draft.splice(sourceIndex, 1)
				if (insertIndex > sourceIndex) insertIndex--
				draft.splice(insertIndex, 0, removed)
			})
		)
	}

	function addItems(addedQueueItems: M.LayerQueueItem[], index?: number) {
		index ??= layerQueue!.length
		setLayerQueue((existing) => {
			existing ??= []
			return [...existing.slice(0, index), ...addedQueueItems, ...existing.slice(index)]
		})
	}
	const [addLayersPopoverOpen, setAddLayersPopoverOpen] = useState(false)
	// we could be more sophisticated with the kind of diffing info we display
	// https://github.com/benjamine/jsondiffpatch
	let addedItemCount = 0
	let editedItemCount = 0
	let movedItemCount = 0
	let deletedItemCount = 0

	if (queueDiff) {
		for (const [k, v] of Object.entries(queueDiff)) {
			if (!k.startsWith('_') && v instanceof Array) {
				addedItemCount++
				continue
			}
			if (!k.startsWith('_') && typeof v === 'object') {
				editedItemCount++
				continue
			}
			if (k.startsWith('_') && v[0] === '') {
				movedItemCount++
				continue
			}

			if (k.startsWith('_') && typeof v[0] === 'object') {
				deletedItemCount++
				continue
			}
		}
	}

	return (
		<div className="contianer mx-auto py-10 grid place-items-center">
			<LayerQueueContext.Provider value={{}}>
				<span className="flex space-x-4">
					{serverState?.currentVote && (
						<VoteState
							abortVote={() => abortVoteMutation.mutateAsync({ seqId: serverState.layerQueueSeqId })}
							startVote={() => startVoteMutation.mutateAsync({ seqId: serverState.layerQueueSeqId })}
							rerunVote={() => startVoteMutation.mutateAsync({ seqId: serverState.layerQueueSeqId, restart: true })}
							state={serverState.currentVote}
							parts={serverState.parts}
						/>
					)}
					<DndContext onDragEnd={handleDragEnd}>
						<Card className="flex flex-col w-max">
							<div className="p-6 w-full flex justify-between">
								<h3 className={Typography.H3}>Layer Queue</h3>
								<AddLayerPopover addQueueItems={addItems} open={addLayersPopoverOpen} onOpenChange={setAddLayersPopoverOpen}>
									<Button className="space-x-1 flex items-center w-min" variant="default">
										<PlusIcon />
										<span>Add To Queue</span>
									</Button>
								</AddLayerPopover>
							</div>
							<CardContent className="flex space-x-4">
								<div>
									{/* ------- top card ------- */}
									<Card>
										{!editing && currentLayer && (
											<>
												<CardHeader>
													<CardTitle>Now Playing</CardTitle>
												</CardHeader>
												<CardContent>{Helpers.toShortLayerName(currentLayer)}</CardContent>
											</>
										)}
										{!editing && !currentLayer && <p className={Typography.P}>No active layer found</p>}
										{editing && (
											<div className="flex flex-col space-y-2">
												<Card>
													<CardHeader>
														<CardTitle>Changes pending</CardTitle>
														<CardDescription>
															{addedItemCount} added, {movedItemCount} moved, {editedItemCount} edited, {deletedItemCount} deleted
														</CardDescription>
													</CardHeader>
													<CardContent>
														<Button onClick={saveLayers}>Save</Button>
														<Button onClick={reset} variant="secondary">
															Cancel
														</Button>
													</CardContent>
												</Card>
											</div>
										)}
									</Card>

									<h4 className={Typography.H4}>Up Next</h4>
									<ScrollArea>
										<ul className="flex flex-col space-y-1 w-max">
											{/* -------- queue items -------- */}
											{layerQueue?.map((item, index) => {
												function dispatch(action: QueueItemAction) {
													if (action.code === 'delete') {
														setLayerQueue((existing) => {
															if (!existing) throw new Error('layerQueue is null')
															const newQueue = existing.filter((_, i) => i !== index)
															return newQueue
														})
													} else if (action.code === 'swap-factions') {
														setLayerQueue((existing) => {
															return existing!.map((currentItem) => {
																if (currentItem.layerId && currentItem.layerId === item!.layerId) {
																	return { ...currentItem, layerId: M.swapFactionsInId(currentItem.layerId) }
																}
																return currentItem
															})
														})
													} else if (action.code === 'add-after') {
														addItems(action.items, index + 1)
													} else if (action.code === 'add-before') {
														addItems(action.items, index)
													}
												}
												let edited = false
												if (queueDiff) {
													if (queueDiff[index]) edited = true
													for (const [k, v] of Object.entries(queueDiff)) {
														if (!v) continue
														if (k.startsWith('_') && v[0] === '' && v[1] === index) {
															edited = true
															break
														}
													}
												}
												return (
													<QueueItem
														key={item.layerId + '-' + index}
														edited={edited}
														item={item}
														index={index}
														isLast={index + 1 === layerQueue.length}
														dispatch={dispatch}
													/>
												)
											})}
										</ul>
									</ScrollArea>
								</div>
							</CardContent>
						</Card>
					</DndContext>
					<PoolConfigurationPanel poolFilterId={poolFilterId} poolFilterEdited={poolFilterEdited} updateFilter={updatePoolFilter} />
				</span>
			</LayerQueueContext.Provider>
		</div>
	)
}

function VoteState(props: { state: M.VoteState; rerunVote: () => void; abortVote: () => void; startVote: () => void } & M.UserPart) {
	const openDialog = useAlertDialog()
	let body: React.ReactNode
	const state = props.state
	const rerunVoteBtn = (
		<Button
			onClick={async () => {
				const id = await openDialog({
					title: 'Rerun Vote',
					description: 'Are you sure you want to return the vote?',
					buttons: [{ label: 'Rerun Vote', id: 'confirm' }],
				})
				if (id === 'confirm') props.rerunVote()
			}}
			variant="secondary"
		>
			Rerun Vote
		</Button>
	)
	const cancelBtn = (
		<Button
			onClick={() => {
				openDialog({
					title: 'Cancel Vote',
					description: 'Are you sure you want to cancel the vote?',
					buttons: [{ label: 'Cancel Vote', id: 'confirm' }],
				}).then((id) => {
					if (id === 'confirm') props.abortVote()
				})
			}}
			variant="secondary"
		>
			Cancel Vote
		</Button>
	)

	switch (state.code) {
		case 'ready':
			body = (
				<span>
					<Button
						onClick={async () => {
							const id = await openDialog({
								title: 'Start Vote',
								description: 'Are you sure you want to start the vote?',
								buttons: [{ label: 'Start Vote', id: 'confirm' }],
							})
							if (id === 'confirm') props.startVote()
						}}
					>
						Start Vote
					</Button>
				</span>
			)
			break
		case 'in-progress':
			{
				const tally = M.tallyVotes(state)
				body = (
					<>
						<Timer deadline={state.deadline} />
						<VoteTallyDisplay {...tally} />
						{rerunVoteBtn}
						{cancelBtn}
					</>
				)
			}
			break
		case 'ended:winner':
			body = (
				<span>
					<span>winner: {Helpers.toShortLayerNameFromId(state.winner)}</span>
					{rerunVoteBtn}
				</span>
			)
			break
		case 'ended:aborted':
			if (state.abortReason === 'manual') {
				const user = props.parts.users.find((u) => u.discordId === state.aborter!)!
				body = (
					<span>
						<Alert>
							<AlertTitle>Vote Aborted</AlertTitle>
							<AlertDescription>Vote was manually aborted by {user.username}</AlertDescription>
						</Alert>
						{rerunVoteBtn}
					</span>
				)
			} else if (state.abortReason === 'timeout:insufficient-votes') {
				body = (
					<span>
						<Alert variant="destructive">
							<AlertTitle>Vote Aborted</AlertTitle>
							<AlertDescription>Vote was aborted due to insufficient votes</AlertDescription>
						</Alert>
						{rerunVoteBtn}
					</span>
				)
			}
			break
		default:
			assertNever(state)
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Vote</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col">{body}</CardContent>
			{/* <CardFooter>{body}</CardFooter> */}
		</Card>
	)
}

function Timer(props: { deadline: number }) {
	const eltRef = useRef<HTMLDivElement>(null)

	// I don't trust react to do this performantly
	React.useLayoutEffect(() => {
		const intervalId = setInterval(() => {
			const timeLeft = Math.max(props.deadline - Date.now(), 0)
			eltRef.current!.innerText = `${Math.floor(timeLeft / 1000 / 60)}:${String(Math.floor((timeLeft / 1000) % 60)).padStart(2, '0')}`
		}, 10)
		return () => clearInterval(intervalId)
	}, [props.deadline])

	return <div ref={eltRef} className={Typography.Blockquote} />
}

function PoolConfigurationPanel(props: {
	poolFilterId: M.ServerState['poolFilterId']
	poolFilterEdited: boolean
	updateFilter: (filter: M.ServerState['poolFilterId']) => void
}) {
	const filtersRes = trpcReact.filters.getFilters.useQuery()
	const filterOptions = filtersRes.data?.map((f) => ({ value: f.id, label: f.name }))
	const selected = props.poolFilterId
	return (
		<Card className="">
			<CardHeader>
				<CardTitle>Pool Configuration</CardTitle>
			</CardHeader>
			<CardContent>
				<ComboBox title="Pool Filter" options={filterOptions ?? LOADING} value={selected} onSelect={props.updateFilter} />
			</CardContent>
		</Card>
	)
}

type QueueItemAction =
	| {
			code: 'swap-factions' | 'delete'
	  }
	| {
			code: 'add-after' | 'add-before'
			items: M.LayerQueueItem[]
	  }

function getQueueItemId(index: number) {
	return `idx-${index}`
}

function getIndexFromQueueItemId(id: string) {
	return parseInt(id.slice(4))
}

function QueueItem(props: {
	item: M.LayerQueueItem
	index: number
	isLast: boolean
	edited: boolean
	dispatch: React.Dispatch<QueueItemAction>
}) {
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: getQueueItemId(props.index),
	})
	const [addAfterPopoverOpen, _setAddAfterPopoverOpen] = useState(false)
	const [addBeforePopoverOpen, _setAddBeforePopoverOpen] = useState(false)
	const [dropdownOpen, _setDropdownOpen] = useState(false)

	function setAddAfterPopoverOpen(open: boolean) {
		if (!open) _setDropdownOpen(false)
		_setAddAfterPopoverOpen(open)
	}

	function setAddBeforePopoverOpen(open: boolean) {
		if (!open) _setDropdownOpen(false)
		_setAddBeforePopoverOpen(open)
	}

	function setDropdownOpen(open: boolean) {
		const popoversOpen = addAfterPopoverOpen || addBeforePopoverOpen
		if (popoversOpen) return
		_setDropdownOpen(open)
	}

	const style = { transform: CSS.Translate.toString(transform) }
	if (props.item.layerId) {
		const layer = M.getMiniLayerFromId(props.item.layerId)
		let color = 'bg-background'
		if (props.edited) color = 'bg-slate-400'
		return (
			<div>
				{props.index === 0 && <QueueItemSeparator afterIndex={-1} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={`px-1 pt-1 pb-2 flex items-center justify-between space-x-2 w-full group ${color} bg-opacity-30 rounded-md ${isDragging ? ' border' : ''}`}
				>
					<div className="flex items-center">
						<Button {...listeners} variant="ghost" size="icon" className="cursor-grab group-hover:visible invisible">
							<GripVertical />
						</Button>
						{Helpers.toShortLevel(layer.Level)} {layer.Gamemode} {layer.LayerVersion || ''}
					</div>
					<div className="flex items-center min-h-0 space-x-1">
						<span>
							{layer.Faction_1} {Helpers.toShortSubfaction(layer.SubFac_1)} vs {layer.Faction_2} {Helpers.toShortSubfaction(layer.SubFac_2)}
						</span>
						<DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
							<DropdownMenuTrigger asChild>
								<Button className="group-hover:visible invisible" variant="ghost" size="icon">
									<EllipsisVertical />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem onClick={() => props.dispatch({ code: 'swap-factions' })}>Swap Factions</DropdownMenuItem>

								{/* ------ Add Layer Before ------ */}
								<AddLayerPopover
									open={addBeforePopoverOpen}
									onOpenChange={setAddBeforePopoverOpen}
									addQueueItems={(items) => {
										props.dispatch({ code: 'add-before', items })
									}}
								>
									<DropdownMenuItem>Add layers before</DropdownMenuItem>
								</AddLayerPopover>

								{/* ------ Add Layer After ------ */}
								<AddLayerPopover
									open={addAfterPopoverOpen}
									onOpenChange={setAddAfterPopoverOpen}
									addQueueItems={(items) => {
										props.dispatch({ code: 'add-after', items })
									}}
								>
									<DropdownMenuItem>Add layers after</DropdownMenuItem>
								</AddLayerPopover>

								<DropdownMenuItem
									onClick={() => {
										return props.dispatch({ code: 'delete' })
									}}
									className="bg-destructive focus:bg-red-600 text-destructive-foreground"
								>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</li>
				<QueueItemSeparator afterIndex={props.index} isLast={props.isLast} />
			</div>
		)
	}
	if (props.item.vote) {
		let color = 'bg-background'
		if (props.edited) color = 'bg-slate-400'
		return (
			<div>
				{props.index === 0 && <QueueItemSeparator afterIndex={-1} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={`px-1 pt-1 pb-2 flex items-center justify-between space-x-2 w-full group ${color} bg-opacity-30 rounded-md ${isDragging ? ' border' : ''}`}
				>
					<div className="flex items-center">
						<Button {...listeners} variant="ghost" size="icon" className="cursor-grab group-hover:visible invisible">
							<GripVertical />
						</Button>
					</div>
					<div className="h-full">
						<label className={Typography.Muted}>Vote</label>
						<ol className={'flex flex-col space-y-1'}>
							{props.item.vote.choices.map((choice, index) => {
								const layer = M.getMiniLayerFromId(choice)
								return (
									<li key={choice} className="flex items-center space-x-2">
										<span>{index + 1}.</span>
										<span>
											{Helpers.toShortLevel(layer.Level)} {layer.Gamemode} {layer.LayerVersion || ''}
										</span>
										<div className="flex items-center min-h-0 space-x-1">
											<span>
												{layer.Faction_1} {Helpers.toShortSubfaction(layer.SubFac_1)} vs {layer.Faction_2}{' '}
												{Helpers.toShortSubfaction(layer.SubFac_2)}
											</span>
										</div>
									</li>
								)
							})}
						</ol>
					</div>
					<DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
						<DropdownMenuTrigger asChild>
							<Button className="group-hover:visible invisible" variant="ghost" size="icon">
								<EllipsisVertical />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem onClick={() => props.dispatch({ code: 'swap-factions' })}>Swap Factions</DropdownMenuItem>

							{/* ------ Add Layer Before ------ */}
							<AddLayerPopover
								open={addBeforePopoverOpen}
								onOpenChange={setAddBeforePopoverOpen}
								addQueueItems={(items) => {
									props.dispatch({ code: 'add-before', items })
								}}
							>
								<DropdownMenuItem>Add layers before</DropdownMenuItem>
							</AddLayerPopover>

							{/* ------ Add Layer After ------ */}
							<AddLayerPopover
								open={addAfterPopoverOpen}
								onOpenChange={setAddAfterPopoverOpen}
								addQueueItems={(items) => {
									props.dispatch({ code: 'add-after', items })
								}}
							>
								<DropdownMenuItem>Add layers after</DropdownMenuItem>
							</AddLayerPopover>

							<DropdownMenuItem
								onClick={() => {
									return props.dispatch({ code: 'delete' })
								}}
								className="bg-destructive focus:bg-red-600 text-destructive-foreground"
							>
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</li>
				<QueueItemSeparator afterIndex={props.index} isLast={props.isLast} />
			</div>
		)
	}
	throw new Error('Unknown layer queue item layout ' + JSON.stringify(props.item))
}

function QueueItemSeparator(props: { afterIndex: number; isLast: boolean }) {
	const { isOver, setNodeRef } = useDroppable({ id: getQueueItemId(props.afterIndex) })
	return (
		<Separator
			ref={setNodeRef}
			className={'w-full min-w-0' + (isOver ? ' bg-green-400' : '') + (props.isLast && !isOver ? ' invisible' : '')}
		/>
	)
}

const differ = diffpatch.create({ arrays: { detectMove: true, includeValueOnMove: false } })
