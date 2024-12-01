import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { produce } from 'immer'
import { EllipsisVertical, GripVertical, PlusIcon, Edit } from 'lucide-react'
import deepEqual from 'fast-deep-equal'
import React, { createContext, useRef, useState } from 'react'
import * as AR from '@/app-routes.ts'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge.tsx'
import { useToast } from '@/hooks/use-toast'
import * as Helpers from '@/lib/display-helpers'
import { trpcReact } from '@/lib/trpc.client.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import * as M from '@/models'

import { SelectLayersPopover, EditLayerQueueItemPopover } from './select-layer-popover'
import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Separator } from '@/components/ui/separator'
import VoteTallyDisplay from './votes-display.tsx'
import { useSquadServerStatus } from '@/hooks/server-state.ts'
import { getNextIntId } from '@/lib/id.ts'
import { useFilter } from '@/hooks/filters.ts'
import { cn } from '@/lib/utils.ts'

const LayerQueueContext = createContext<object>({})

export default function LayerQueue() {
	const [layerQueue, setLayerQueue] = useState(null as null | IdedLayerQueueItem[])
	const serverStatus = useSquadServerStatus()
	const currentLayer = serverStatus?.currentLayer
	const [settings, setSettings] = useState({ queue: {} } as M.ServerSettings)
	const [queueMutations, setQueueMutations] = useState(initMutations())

	const [serverState, setServerState] = useState(null as null | (M.ServerState & M.UserPart))
	const layerQueueSeqIdRef = useRef(-1)
	const editing = hasMutations(queueMutations) || !deepEqual(settings, serverState?.settings)

	function initLayerQueue(initialQueue: M.LayerQueue) {
		setLayerQueue(initialQueue.map((item, idx) => ({ ...item, id: idx })))
	}

	trpcReact.server.watchServerState.useSubscription(undefined, {
		onData: (data) => {
			initLayerQueue(data.layerQueue)
			setSettings(data.settings)
			setServerState(data)
			setQueueMutations(initMutations())
			layerQueueSeqIdRef.current = data.layerQueueSeqId
		},
	})

	const basePoolFilter = useFilter(settings.queue.poolFilterId, {
		onUpdate: () => {
			toaster.toast({ title: 'Pool Filter Updated' })
		},
	})

	const abortVoteMutation = trpcReact.server.abortVote.useMutation()
	async function abortVote() {
		const res = await abortVoteMutation.mutateAsync({ seqId: layerQueueSeqIdRef.current })

		if (res.code === 'ok') {
			toaster.toast({ title: 'Vote aborted' })
			return
		}
		return toaster.toast({ title: 'Failed to abort vote', description: res.code, variant: 'destructive' })
	}
	const startVoteMutation = trpcReact.server.startVote.useMutation()
	async function startVote() {
		const res = await startVoteMutation.mutateAsync({ seqId: serverState!.layerQueueSeqId })
		if (res.code === 'ok') {
			toaster.toast({ title: 'Vote started' })
			return
		}
		toaster.toast({ title: 'Failed to start vote', description: res.code, variant: 'destructive' })
	}

	async function rerunVote() {
		const res = await startVoteMutation.mutateAsync({ seqId: serverState!.layerQueueSeqId, restart: true })
		if (res.code === 'ok') {
			toaster.toast({ title: 'Vote restarted' })
			return
		}
		toaster.toast({ title: 'Failed to restart vote', description: res.code, variant: 'destructive' })
	}

	const toaster = useToast()
	const updateQueueMutation = trpcReact.server.updateQueue.useMutation()
	async function saveLayers() {
		if (!editing || !layerQueue || !serverState) return
		const res = await updateQueueMutation.mutateAsync({
			queue: layerQueue.map((item) => {
				const idStripped: M.LayerQueueItem = { ...item }

				//@ts-expect-error id is not in LayerQueueItem
				delete idStripped['id']
				return idStripped
			}),
			seqId: layerQueueSeqIdRef.current,
			settings,
		})
		if (res.code === 'err:next-layer-changed-while-vote-active') {
			toaster.toast({
				title: 'Cannot update: active layer vote in progress',
				variant: 'destructive',
			})
			return
		}
		if (res.code === 'err:out-of-sync') {
			toaster.toast({ title: 'State changed before submission, please try again.', variant: 'destructive' })
			return
		}
		if (res.code === 'ok') {
			toaster.toast({ title: 'Changes applied' })
			return
		}
	}

	function reset() {
		if (!editing || !layerQueue || !serverState) return
		initLayerQueue(serverState.layerQueue)
		setQueueMutations(initMutations())
		setSettings(serverState.settings)
	}

	function handleDragEnd(event: DragEndEvent) {
		if (!event.over) return
		const sourceIndex = getIndexFromQueueItemId(layerQueue!, fromItemId(event.active.id as string))
		const targetIndex = getIndexFromQueueItemId(layerQueue!, fromItemId(event.over.id as string))
		if (sourceIndex === targetIndex || targetIndex + 1 === sourceIndex) return
		const sourceId = layerQueue![sourceIndex].id
		setQueueMutations(
			produce((draft) => {
				draft.moved.add(sourceId)
			})
		)
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
			const withIds = getNewItemsWithIds(existing, addedQueueItems)
			const ids = withIds.map((item) => item.id)
			setQueueMutations(
				produce((draft) => {
					for (const id of ids) {
						tryApplyMutation('added', id, draft)
					}
				})
			)
			return [...existing.slice(0, index), ...withIds, ...existing.slice(index)]
		})
	}

	const [addLayersPopoverOpen, setAddLayersPopoverOpen] = useState(false)

	return (
		<div className="contianer mx-auto grid place-items-center py-10">
			<LayerQueueContext.Provider value={{}}>
				<span className="flex space-x-4">
					{serverState?.currentVote && (
						<VoteState
							abortVote={abortVote}
							startVote={startVote}
							rerunVote={rerunVote}
							state={serverState.currentVote}
							parts={serverState.parts}
						/>
					)}
					<DndContext onDragEnd={handleDragEnd}>
						<Card className="flex w-max flex-col">
							<div className="flex w-full justify-between p-6">
								<h3 className={Typography.H3}>Layer Queue</h3>
								<SelectLayersPopover
									title="Add to Queue"
									baseFilter={basePoolFilter?.filter}
									selectQueueItems={addItems}
									open={addLayersPopoverOpen}
									onOpenChange={setAddLayersPopoverOpen}
								>
									<Button className="flex w-min items-center space-x-1" variant="default">
										<PlusIcon />
										<span>Add To Queue</span>
									</Button>
								</SelectLayersPopover>
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
															<Badge>{queueMutations.added.size} added</Badge>, {queueMutations.moved.size} moved,{' '}
															{queueMutations.edited.size} edited, {queueMutations.removed.size} deleted
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
										<ul className="flex w-max flex-col space-y-1">
											{/* -------- queue items -------- */}
											{layerQueue?.map((item, index) => {
												function dispatch(action: QueueItemAction) {
													if (action.code === 'delete') {
														setLayerQueue((existing) => {
															if (!existing) throw new Error('layerQueue is null')
															const newQueue = existing.filter((_, i) => i !== index)
															return newQueue
														})
														setQueueMutations(
															produce((draft) => {
																tryApplyMutation('removed', item.id, draft)
															})
														)
													} else if (action.code === 'edit') {
														setLayerQueue(
															produce((draft) => {
																if (!draft) return
																for (let i = 0; i < draft.length; i++) {
																	const existing = draft[i]
																	if (existing.id === item.id) {
																		draft[i] = { id: item.id, ...action.item }
																		break
																	}
																}
																setQueueMutations(produce((draft) => tryApplyMutation('edited', item.id, draft)))
															})
														)
													} else if (action.code === 'add-after') {
														addItems(action.items, index + 1)
													} else if (action.code === 'add-before') {
														addItems(action.items, index)
													}
												}
												return (
													<QueueItem
														key={item.layerId + '-' + index}
														mutationState={toItemMutationState(queueMutations, item.id)}
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
					<ServerSettingsPanel settings={settings} setSettings={setSettings} />
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
				body = (
					<>
						<Timer deadline={state.deadline} />
						<VoteTallyDisplay voteState={state} />
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
				const user = props.parts.users.find((u) => u.discordId === BigInt(state.aborter!))!
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

function ServerSettingsPanel(props: { settings: M.ServerSettings; setSettings: React.Dispatch<React.SetStateAction<M.ServerSettings>> }) {
	const filtersRes = trpcReact.filters.getFilters.useQuery()
	const filterOptions = filtersRes.data?.map((f) => ({ value: f.id, label: f.name }))
	return (
		<Card className="">
			<CardHeader>
				<CardTitle>Pool Configuration</CardTitle>
			</CardHeader>
			<CardContent>
				<span className="flex items-center space-x-1">
					<ComboBox
						title="Pool Filter"
						options={filterOptions ?? LOADING}
						value={props.settings.queue.poolFilterId}
						onSelect={(filter) =>
							props.setSettings(
								produce((draft) => {
									draft.queue.poolFilterId = filter ?? undefined
								})
							)
						}
					/>
					{props.settings.queue.poolFilterId && (
						<a
							className={buttonVariants({ variant: 'ghost', size: 'icon' })}
							target="_blank"
							href={AR.link('/filters/:id/edit', props.settings.queue.poolFilterId)}
						>
							<Edit />
						</a>
					)}
				</span>
				<Button>Reload Pool</Button>
			</CardContent>
		</Card>
	)
}

type QueueItemAction =
	| {
			code: 'edit'
			item: M.LayerQueueItem
	  }
	| {
			code: 'delete'
	  }
	| {
			code: 'add-after' | 'add-before'
			items: M.LayerQueueItem[]
	  }

function getIndexFromQueueItemId(items: IdedLayerQueueItem[], id: number | null) {
	if (id === null) return -1
	return items.findIndex((item) => item.id === id)
}

type QueueItemProps = {
	index: number
	item: IdedLayerQueueItem
	mutationState: { [key in keyof QueueMutations]: boolean }
	isLast: boolean
	dispatch: React.Dispatch<QueueItemAction>
}

function QueueItem(props: QueueItemProps) {
	const draggableItemId = toDraggableItemId(props.item.id)
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: draggableItemId,
	})

	const [dropdownOpen, setDropdownOpen] = useState(false)

	const style = { transform: CSS.Translate.toString(transform) }
	const itemDropdown = (
		<ItemDropdown open={dropdownOpen} setOpen={setDropdownOpen} dispatch={props.dispatch} item={props.item}>
			<Button className="invisible group-hover:visible" variant="ghost" size="icon">
				<EllipsisVertical />
			</Button>
		</ItemDropdown>
	)
	const queueItemStyles = `bg-background data-[mutation=added]:${MUTATION_COLORS.added} data-[mutation=moved]:${MUTATION_COLORS.moved} data-[mutation=edited]:${MUTATION_COLORS.edited} data-[is-dragging]:border rounded-md bg-opacity-30`

	if (props.item.vote) {
		return (
			<div>
				{props.index === 0 && <QueueItemSeparator itemId={toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn('group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1', queueItemStyles)}
					data-mutation={getDisplayedMutation(props.mutationState)}
					data-is-dragging={isDragging}
				>
					<div className="flex items-center">
						<Button {...listeners} variant="ghost" size="icon" className="invisible cursor-grab group-hover:visible">
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
										<div className="flex min-h-0 items-center space-x-1">
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
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</div>
		)
	}

	if (props.item.layerId) {
		const layer = M.getMiniLayerFromId(props.item.layerId)
		return (
			<div>
				{props.index === 0 && <QueueItemSeparator itemId={toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn(`group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1`, queueItemStyles)}
					data-mutation={getDisplayedMutation(props.mutationState)}
					data-is-dragging={isDragging}
				>
					<div className="flex items-center">
						<Button {...listeners} variant="ghost" size="icon" className="invisible cursor-grab group-hover:visible">
							<GripVertical />
						</Button>
						{Helpers.toShortLevel(layer.Level)} {layer.Gamemode} {layer.LayerVersion || ''}
					</div>
					<div className="flex min-h-0 items-center space-x-1">
						<span>
							{layer.Faction_1} {Helpers.toShortSubfaction(layer.SubFac_1)} vs {layer.Faction_2} {Helpers.toShortSubfaction(layer.SubFac_2)}
						</span>
						{itemDropdown}
					</div>
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</div>
		)
	}

	throw new Error('Unknown layer queue item layout ' + JSON.stringify(props.item))
}

function ItemDropdown(props: {
	children: React.ReactNode
	item: M.LayerQueueItem
	dispatch: React.Dispatch<QueueItemAction>
	open: boolean
	setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
	const [dropdownOpen, setDropdownOpen] = useState(false)

	type SubDropdownState = 'add-before' | 'add-after' | 'edit' | null
	const [subDropdownState, _setSubDropdownState] = useState(null as SubDropdownState)

	function setSubDropdownState(state: SubDropdownState) {
		if (state === null) props.setOpen(false)
		_setSubDropdownState(state)
	}

	const layersInItem: M.MiniLayer[] = []
	if (props.item.vote) {
		for (const choice of props.item.vote.choices) {
			layersInItem.push(M.getMiniLayerFromId(choice))
		}
	} else if (props.item.layerId) {
		layersInItem.push(M.getMiniLayerFromId(props.item.layerId))
	}

	return (
		<DropdownMenu open={dropdownOpen || !!subDropdownState} onOpenChange={setDropdownOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<EditLayerQueueItemPopover
					open={subDropdownState === 'edit'}
					onOpenChange={(update) => {
						const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
						return setSubDropdownState(open ? 'edit' : null)
					}}
					item={props.item}
					setItem={(update) => {
						const newItem = typeof update === 'function' ? update(props.item) : update
						props.dispatch({ code: 'edit', item: newItem })
					}}
				>
					<DropdownMenuItem>Edit</DropdownMenuItem>
				</EditLayerQueueItemPopover>

				<SelectLayersPopover
					title="Add layers before"
					open={subDropdownState === 'add-before'}
					onOpenChange={(open) => setSubDropdownState(open ? 'add-before' : null)}
					selectingSingleLayerQueueItem={true}
					selectQueueItems={(items) => {
						props.dispatch({ code: 'add-before', items })
					}}
				>
					<DropdownMenuItem>Add layers before</DropdownMenuItem>
				</SelectLayersPopover>

				<SelectLayersPopover
					title="Add layers after"
					open={subDropdownState === 'add-after'}
					onOpenChange={(open) => setSubDropdownState(open ? 'add-after' : null)}
					selectQueueItems={(items) => {
						props.dispatch({ code: 'add-after', items })
					}}
				>
					<DropdownMenuItem>Add layers after</DropdownMenuItem>
				</SelectLayersPopover>

				<DropdownMenuItem
					onClick={() => {
						return props.dispatch({ code: 'delete' })
					}}
					className="bg-destructive text-destructive-foreground focus:bg-red-600"
				>
					Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function QueueItemSeparator(props: {
	// null means we're before the first item in the list
	itemId: string
	isLast: boolean
}) {
	const { isOver, setNodeRef } = useDroppable({ id: props.itemId })
	return (
		<Separator
			ref={setNodeRef}
			className="w-full min-w-0 data-[is-last=true]:invisible data-[is-over=true]:bg-green-400"
			data-is-last={props.isLast && !isOver}
			data-is-over={isOver}
		/>
	)
}

// -------- Queue Mutations --------
type QueueMutations = {
	added: Set<number>
	removed: Set<number>
	moved: Set<number>
	edited: Set<number>
}

const MUTATION_COLORS = {
	added: 'bg-green-600',
	moved: 'bg-blue-600',
	removed: 'bg-red-600',
	edited: 'bg-orange-600',
}

type ItemMutationState = { [key in keyof QueueMutations]: boolean }

function getDisplayedMutation(mutation: ItemMutationState) {
	if (mutation.added) return 'added'
	if (mutation.removed) return 'removed'
	if (mutation.moved) return 'moved'
	if (mutation.edited) return 'edited'
}
function tryApplyMutation(type: keyof QueueMutations, id: number, mutations: QueueMutations) {
	if (type === 'added') {
		mutations.added.add(id)
	}
	if (type === 'removed') {
		if (mutations.added.has(id)) {
			mutations.added.delete(id)
			return
		}
		mutations.removed.add(id)
		mutations.edited.delete(id)
		mutations.moved.delete(id)
	}
	if (type === 'moved' && !mutations.added.has(id)) {
		mutations.moved.add(id)
	}
	if (type === 'edited' && !mutations.added.has(id)) {
		mutations.edited.add(id)
	}
}

function getAllMutationIds(mutations: QueueMutations) {
	return new Set([...mutations.added, ...mutations.removed, ...mutations.moved, ...mutations.edited])
}

function initMutations(): QueueMutations {
	return { added: new Set(), removed: new Set(), moved: new Set(), edited: new Set() }
}

function hasMutations(mutations: QueueMutations) {
	return mutations.added.size > 0 || mutations.removed.size > 0 || mutations.moved.size > 0
}

function toItemMutationState(mutations: QueueMutations, id: number): ItemMutationState {
	return {
		added: mutations.added.has(id),
		removed: mutations.removed.has(id),
		moved: mutations.moved.has(id),
		edited: mutations.edited.has(id),
	}
}

function getNewItemsWithIds(existingItems: IdedLayerQueueItem[], newItems: M.LayerQueueItem[]) {
	const ids = existingItems.map((item) => item.id)
	const withIds = []
	for (const item of newItems) {
		const id = getNextIntId(ids)
		withIds.push({
			...item,
			id: id,
		})
		ids.push(id)
	}
	return withIds
}

function toDraggableItemId(id: number | null) {
	return JSON.stringify(id)
}

function fromItemId(serialized: string) {
	return JSON.parse(serialized) as number | null
}
type IdedLayerQueueItem = M.LayerQueueItem & { id: number }
