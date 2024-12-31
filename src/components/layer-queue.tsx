import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { produce } from 'immer'
import { Edit, EllipsisVertical, GripVertical, Minus, PlusIcon } from 'lucide-react'
import deepEqual from 'fast-deep-equal'
import React, { useRef, useState } from 'react'
import * as AR from '@/app-routes.ts'
import * as FB from '@/lib/filter-builders.ts'

import { createAtomStore } from 'jotai-x'
import { atom, createStore } from 'jotai'
import { withImmer } from 'jotai-immer'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge.tsx'
import { useToast } from '@/hooks/use-toast'
import * as Helpers from '@/lib/display-helpers'
import { trpcReact } from '@/lib/trpc.client.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import * as M from '@/models'

import { EditLayerQueueItemPopover, SelectLayersPopover } from './select-layer-popover'
import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Separator } from '@/components/ui/separator'
import VoteTallyDisplay from './votes-display.tsx'
import { useSquadServerStatus } from '@/hooks/server-state.ts'
import { createId } from '@/lib/id.ts'
import { useFilter } from '@/hooks/filters.ts'
import { cn } from '@/lib/utils.ts'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Comparison } from './filter-card.tsx'
import { Checkbox } from './ui/checkbox.tsx'

import { useHistoryFilterNode } from '@/hooks/history-filter.ts'
import {
	getDisplayedMutation,
	hasMutations,
	initMutations,
	toItemMutationState,
	tryApplyMutation,
	WithMutationId,
} from '@/lib/item-mutations.ts'

type EditedHistoryFilterWithId = M.HistoryFilterEdited & WithMutationId
type MutServerStateWithIds = M.MutableServerState & {
	layerQueue: IdedLayerQueueItem[]
	historyFilters: EditedHistoryFilterWithId[]
}

type SDStore = {
	serverState: (M.ServerState & M.UserPart) | null
	serverStateMut: MutServerStateWithIds | null
	queueMutations: ItemMutations
	historyFiltersMutations: ItemMutations
}

const initialState: SDStore = {
	serverState: null,
	serverStateMut: null,
	queueMutations: initMutations(),
	historyFiltersMutations: initMutations(),
}

// TODO I don't really like this jotai-x thing, should probably just move away from it
const { SDStore, useSDStore, SDProvider } = createAtomStore(initialState, {
	name: 'SD',
	extend: (atoms) => {
		const addQueueItems = atom(null, (get, set, items: M.LayerQueueItem[], index?: number) => {
			index ??= get(atoms.serverStateMut)!.layerQueue.length
			const existing = get(atoms.serverStateMut)!.layerQueue
			const withIds = [...existing, ...items].map((item) => ({ id: createId(6), ...item }))
			set(withImmer(atoms.queueMutations), (draft) => {
				for (const { id } of withIds) {
					tryApplyMutation('added', id, draft)
				}
			})
			set(withImmer(atoms.serverStateMut), (draft) => {
				draft!.layerQueue = [...existing.slice(0, index), ...withIds, ...existing.slice(index)] as IdedLayerQueueItem[]
			})
		})
		return {
			editing: atom((get) => {
				return (
					hasMutations(get(atoms.queueMutations)) ||
					!deepEqual(get(atoms.serverState)?.settings, get(atoms.serverStateMut)?.settings) ||
					hasMutations(get(atoms.historyFiltersMutations))
				)
			}),
			reset: atom(null, (get, set) => {
				const serverState = get(atoms.serverState)
				if (serverState === null) {
					set(atoms.serverStateMut, null)
				} else {
					set(atoms.serverStateMut, {
						...serverState,
						//@ts-expect-error idk
						historyFilters: serverState.historyFilters.map((filter, idx) => ({ ...filter, id: idx }) as M.HistoryFilterEdited & WithId),
						layerQueue: serverState.layerQueue.map((item) => ({
							...item,
							id: createId(6),
						})),
					})
				}
				set(atoms.queueMutations, initMutations())
				set(atoms.historyFiltersMutations, initMutations())
			}),
			applyServerUpdate: atom(null, (_, set, update: M.ServerState & M.UserPart) => {
				set(atoms.serverState, update)
				set(atoms.serverStateMut, {
					historyFiltersEnabled: update.historyFiltersEnabled,
					layerQueueSeqId: update.layerQueueSeqId,
					settings: update.settings,
					//@ts-expect-error idk
					historyFilters: update.historyFilters.map((filter, idx) => ({ ...filter, id: idx }) as M.HistoryFilterEdited & WithId),
					layerQueue: update.layerQueue.map((item) => ({
						...item,
						id: createId(6),
					})),
				})
				set(atoms.queueMutations, initMutations())
				set(atoms.historyFiltersMutations, initMutations())
			}),
			changedSettings: atom((get) => {
				const serverStateSettings = get(atoms.serverState)?.settings
				const mutSettings = get(atoms.serverStateMut)?.settings
				if (!serverStateSettings || !mutSettings) return null
				return M.getSettingsChanged(serverStateSettings, mutSettings)
			}),
			validatedHistoryFilters: atom((get) => {
				const historyFilters = get(atoms.serverStateMut)?.historyFilters
				if (!historyFilters) return []
				const validated: M.HistoryFilter[] = []
				for (const filter of historyFilters) {
					const res = M.HistoryFilterSchema.safeParse(filter)
					if (res.success) {
						validated.push(res.data)
					}
				}
				return validated
			}),
			handleDragEnd: atom(null, (get, set, event: DragEndEvent, userDiscordId: bigint) => {
				if (!event.over) return
				const layerQueue = get(atoms.serverStateMut)!.layerQueue
				const sourceIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.active.id as string))
				const targetIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.over.id as string))
				if (sourceIndex === targetIndex || targetIndex + 1 === sourceIndex) return
				const sourceId = layerQueue[sourceIndex].id
				set(withImmer(atoms.serverStateMut), (draft) => {
					const layerQueue = draft!.layerQueue
					let insertIndex = targetIndex + 1
					if (!layerQueue) throw new Error('layerQueue is null')
					const [moved] = layerQueue.splice(sourceIndex, 1).map(
						(moved) =>
							({
								...moved,
								source: 'manual',
								lastModifiedBy: userDiscordId,
							}) as IdedLayerQueueItem
					)
					moved.source = 'manual'
					if (insertIndex > sourceIndex) insertIndex--
					layerQueue.splice(insertIndex, 0, moved)
				})
				set(withImmer(atoms.queueMutations), (draft) => {
					tryApplyMutation('moved', sourceId, draft)
				})
			}),
			addQueueItems,
			layerQueue: atom((get) => get(atoms.serverStateMut)?.layerQueue),
			dispatchQueueItemAction: atom(null, (get, set, action: QueueItemAction) => {
				const layerQueue = get(atoms.serverStateMut)!.layerQueue as IdedLayerQueueItem[]
				if (action.code === 'delete') {
					set(withImmer(atoms.queueMutations), (draft) => {
						tryApplyMutation('removed', layerQueue[layerQueue.length - 1].id, draft)
					})
					set(withImmer(atoms.serverStateMut), (draft) => {
						draft!.layerQueue = draft!.layerQueue.filter((_, i) => i !== layerQueue.length - 1) as IdedLayerQueueItem[]
					})
				} else if (action.code === 'edit') {
					set(withImmer(atoms.queueMutations), (draft) => {
						tryApplyMutation('edited', action.item.id, draft)
					})
					const index = layerQueue.findIndex((item) => item.id === action.item.id)
					set(withImmer(atoms.serverStateMut), (draft) => {
						draft!.layerQueue[index] = action.item
					})
				} else if (action.code === 'add-after') {
					const itemIndex = layerQueue.findIndex((item) => item.id === action.id)
					set(addQueueItems, action.items, itemIndex)
				} else if (action.code === 'add-before') {
					const itemIndex = layerQueue.findIndex((item) => item.id === action.id)
					set(addQueueItems, action.items, itemIndex)
				}
			}),
			historyFilterActions: {
				add: atom(null, (get, set, newFilter: M.HistoryFilter) => {
					const newId = createId(6)
					set(withImmer(atoms.historyFiltersMutations), (draft) => {
						tryApplyMutation('added', newId, draft)
					})
					set(withImmer(atoms.serverStateMut), (draft) => {
						draft!.historyFilters.push({ id: newId, ...newFilter } as EditedHistoryFilterWithId)
					})
				}),
				remove: atom(null, (_, set, id: string) => {
					set(withImmer(atoms.historyFiltersMutations), (draft) => {
						tryApplyMutation('removed', id, draft)
					})
					set(withImmer(atoms.serverStateMut), (draft) => {
						draft!.historyFilters = (draft!.historyFilters as EditedHistoryFilterWithId[]).filter(
							(f) => f.id !== id
						) as EditedHistoryFilterWithId[]
					})
				}),
				edit: atom(null, (_, set, id: string, update: React.SetStateAction<EditedHistoryFilterWithId>) => {
					set(withImmer(atoms.historyFiltersMutations), (draft) => {
						tryApplyMutation('edited', id, draft)
					})
					set(withImmer(atoms.serverStateMut), (draft) => {
						const filters = draft!.historyFilters as EditedHistoryFilterWithId[]
						const idx = filters.findIndex((f) => f.id === id)
						if (typeof update === 'function') {
							filters[idx] = update(filters[idx])
						} else {
							filters[idx] = update
						}
					})
				}),
			},
			layerQueueItemActions: {
				delete: atom(null, (_, set, id: string) => {
					set(withImmer(atoms.queueMutations), (draft) => {
						tryApplyMutation('removed', id, draft)
					})
					set(withImmer(atoms.serverStateMut), (draft) => {
						//@ts-expect-error idk
						draft!.layerQueue = draft!.layerQueue.filter((item) => item.id !== id)
					})
				}),
				edit: atom(null, (_, set, id: string, update: React.SetStateAction<M.LayerQueueItem>) => {
					set(withImmer(atoms.queueMutations), (draft) => {
						tryApplyMutation('edited', id, draft)
					})
					set(withImmer(atoms.serverStateMut), (draft) => {
						const layerQueue = draft!.layerQueue as IdedLayerQueueItem[]
						const idx = layerQueue.findIndex((item) => item.id === id)
						if (typeof update === 'function') {
							//@ts-expect-error idk
							layerQueue[idx] = update(draft!.layerQueue[idx])
						} else {
							//@ts-expect-error idk
							layerQueue[idx] = update
						}
					})
				}),
				addBefore: atom(null, (get, set, id: string, items: M.LayerQueueItem[]) => {
					const layerQueue = get(atoms.serverStateMut)!.layerQueue as IdedLayerQueueItem[]
					const index = layerQueue.findIndex((item) => item.id === id)
					set(addQueueItems, items, index)
				}),
				addAfter: atom(null, (get, set, id: string, items: M.LayerQueueItem[]) => {
					const layerQueue = get(atoms.serverStateMut)!.layerQueue as IdedLayerQueueItem[]
					const index = layerQueue.findIndex((item) => item.id === id)
					set(addQueueItems, items, index + 1)
				}),
			},
		}
	},
})

export default function ServerDashBoardWrapped() {
	return (
		<SDProvider>
			<ServerDashboard />
		</SDProvider>
	)
}

function ServerDashboard() {
	const serverStatus = useSquadServerStatus()
	const settingsPanelRef = useRef<ServerSettingsPanelHandle>(null)
	const serverState = useSDStore().get.serverState()
	const serverStateMut = useSDStore().get.serverStateMut()
	const resetSDStore = useSDStore().set.reset()
	const sdStore = useSDStore().store()!

	trpcReact.server.watchServerState.useSubscription(undefined, {
		onData: (data) => {
			sdStore.set(SDStore.atom.applyServerUpdate, data)
			settingsPanelRef.current?.reset(data.settings)
		},
	})

	const basePoolFilterEntity = useFilter(serverStateMut?.settings?.queue.poolFilterId, {
		onUpdate: () => {
			toaster.toast({ title: 'Pool Filter Updated' })
		},
	})

	let basePoolFilter = basePoolFilterEntity?.filter

	const validatedHistoryFilters = useSDStore().get.validatedHistoryFilters()
	const historyFilterRes = useHistoryFilterNode({
		historyFilters: validatedHistoryFilters,
		layerQueue: serverStateMut?.layerQueue ?? [],
		enabled:
			validatedHistoryFilters.length === serverStateMut?.historyFilters.length &&
			serverStateMut?.layerQueue !== null &&
			serverStateMut.historyFiltersEnabled,
	})

	if (historyFilterRes.isSuccess && historyFilterRes.data && serverStateMut?.historyFiltersEnabled && basePoolFilter) {
		basePoolFilter = FB.and([basePoolFilter, historyFilterRes.data])
	}

	const abortVoteMutation = trpcReact.server.abortVote.useMutation()
	async function abortVote() {
		if (!serverStateMut?.layerQueueSeqId) return
		const res = await abortVoteMutation.mutateAsync({
			seqId: serverStateMut?.layerQueueSeqId,
		})

		if (res.code === 'ok') {
			toaster.toast({ title: 'Vote aborted' })
			return
		}
		return toaster.toast({
			title: 'Failed to abort vote',
			description: res.code,
			variant: 'destructive',
		})
	}

	const startVoteMutation = trpcReact.server.startVote.useMutation()
	async function startVote() {
		const res = await startVoteMutation.mutateAsync({
			seqId: serverState!.layerQueueSeqId,
		})
		if (res.code === 'ok') {
			toaster.toast({ title: 'Vote started' })
			return
		}
		toaster.toast({
			title: 'Failed to start vote',
			description: res.code,
			variant: 'destructive',
		})
	}

	async function rerunVote() {
		const res = await startVoteMutation.mutateAsync({
			seqId: serverState!.layerQueueSeqId,
			restart: true,
		})
		if (res.code === 'ok') {
			toaster.toast({ title: 'Vote restarted' })
			return
		}
		toaster.toast({
			title: 'Failed to restart vote',
			description: res.code,
			variant: 'destructive',
		})
	}

	const toaster = useToast()
	const updateQueueMutation = trpcReact.server.updateQueue.useMutation()
	// const validatedHistoryFilters = M.histo
	async function saveLayers() {
		if (!serverStateMut) return
		const res = await updateQueueMutation.mutateAsync(serverStateMut)
		if (res.code === 'err:next-layer-changed-while-vote-active') {
			toaster.toast({
				title: 'Cannot update: active layer vote in progress',
				variant: 'destructive',
			})
			return
		}
		if (res.code === 'err:out-of-sync') {
			toaster.toast({
				title: 'State changed before submission, please try again.',
				variant: 'destructive',
			})
			return
		}
		if (res.code === 'ok') {
			toaster.toast({ title: 'Changes applied' })
			return
		}
	}

	const handleDragEnd = useSDStore().set.handleDragEnd()

	const [playNextPopoverOpen, setPlayNextPopoverOpen] = useState(false)
	const [appendLayersPopoverOpen, setAppendLayersPopoverOpen] = useState(false)
	const addQueueItems = useSDStore().set.addQueueItems()
	const editing = useSDStore().get.editing()
	const queueMutations = useSDStore().get.queueMutations()

	return (
		<div className="contianer mx-auto grid place-items-center py-10">
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
				<Card className="flex w-max flex-col">
					<div className="flex w-full justify-between p-6 space-x-2">
						<h3 className={Typography.H3}>Layer Queue</h3>
						<div className="flex items-center space-x-1">
							<SelectLayersPopover
								title="Add to Queue"
								description="Select layers to add to the queue"
								baseFilter={basePoolFilterEntity?.filter}
								selectQueueItems={addQueueItems}
								open={appendLayersPopoverOpen}
								onOpenChange={setAppendLayersPopoverOpen}
							>
								<Button className="flex w-min items-center space-x-1" variant="default">
									<PlusIcon />
									<span>Play After</span>
								</Button>
							</SelectLayersPopover>
							<SelectLayersPopover
								title="Play Next"
								description="Select layers to play next"
								baseFilter={basePoolFilterEntity?.filter}
								selectQueueItems={(items) => addQueueItems(items, 0)}
								open={playNextPopoverOpen}
								onOpenChange={setPlayNextPopoverOpen}
							>
								<Button className="flex w-min items-center space-x-1" variant="default">
									<PlusIcon />
									<span>Play Next</span>
								</Button>
							</SelectLayersPopover>
						</div>
					</div>
					<CardContent className="flex space-x-4">
						<div>
							{/* ------- top card ------- */}
							<Card>
								{!editing && serverStatus?.currentLayer && (
									<>
										<CardHeader>
											<CardTitle>Now Playing</CardTitle>
										</CardHeader>
										<CardContent>{Helpers.toShortLayerName(serverStatus?.currentLayer)}</CardContent>
									</>
								)}
								{!editing && !serverStatus?.currentLayer && <p className={Typography.P}>No active layer found</p>}
								{editing && (
									<div className="flex flex-col space-y-2">
										<Card>
											<CardContent>
												{hasMutations(queueMutations) && (
													<>
														<h3>Layer Changes pending</h3>
														<span className="flex space-x-1">
															{queueMutations.added.size > 0 && <Badge variant="added">{queueMutations.added.size} added</Badge>}
															{queueMutations.removed.size > 0 && <Badge variant="removed">{queueMutations.removed.size} deleted</Badge>}
															{queueMutations.moved.size > 0 && <Badge variant="moved">{queueMutations.moved.size} moved</Badge>}
															{queueMutations.edited.size > 0 && <Badge variant="edited">{queueMutations.edited.size} edited</Badge>}
														</span>
													</>
												)}
											</CardContent>
											<CardFooter className="space-x-1">
												<Button onClick={saveLayers}>Save</Button>
												<Button onClick={resetSDStore} variant="secondary">
													Cancel
												</Button>
											</CardFooter>
										</Card>
									</div>
								)}
							</Card>

							<h4 className={Typography.H4}>Up Next</h4>
							<LayerQueue
								layerQueue={serverStateMut?.layerQueue ?? []}
								queueMutations={queueMutations}
								dispatchQueueItemAction={(action) => sdStore.set(SDStore.atom.dispatchQueueItemAction, action)}
								handleDragEnd={handleDragEnd}
							/>
						</div>
					</CardContent>
				</Card>
				<ServerSettingsPanel ref={settingsPanelRef} />
			</span>
		</div>
	)
}

// TODO the atoms relevant to LayerQueue should be abstracted into a separate store at some point, for expediency we're just going to call the same atoms under a different store
export function LayerQueue(props: {
	layerQueue: IdedLayerQueueItem[]
	queueMutations: ItemMutations
	dispatchQueueItemAction: (action: QueueItemAction) => void
	allowVotes?: boolean
	handleDragEnd: (evt: DragEndEvent, userDiscordId: bigint) => void
}) {
	const userQuery = trpcReact.getLoggedInUser.useQuery()
	const allowVotes = props.allowVotes ?? true
	return (
		<DndContext onDragEnd={(evt) => props.handleDragEnd(evt, userQuery.data!.discordId)}>
			<ScrollArea>
				<ul className="flex w-max flex-col space-y-1">
					{/* -------- queue items -------- */}
					{props.layerQueue?.map((item, index) => (
						<QueueItem
							allowVotes={allowVotes}
							key={item.id}
							mutationState={toItemMutationState(props.queueMutations, item.id)}
							item={item}
							index={index}
							isLast={index + 1 === props.layerQueue.length}
							dispatch={props.dispatchQueueItemAction}
						/>
					))}
				</ul>
			</ScrollArea>
		</DndContext>
	)
}

function VoteState(
	props: {
		state: M.VoteState
		rerunVote: () => void
		abortVote: () => void
		startVote: () => void
	} & M.UserPart
) {
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

type ServerSettingsPanelHandle = {
	reset(settings: M.ServerSettings): void
}
const ServerSettingsPanel = React.forwardRef(function ServerSettingsPanel(
	props: object,
	ref: React.ForwardedRef<ServerSettingsPanelHandle>
) {
	const filtersRes = trpcReact.filters.getFilters.useQuery()

	const preferredLengthRef = React.useRef<HTMLInputElement>(null)
	const preferredLengthId = React.useId()

	const preferredNumVoteChoicesRef = React.useRef<HTMLInputElement>(null)
	const preferredNumVoteChoicesId = React.useId()

	const filterOptions = filtersRes.data?.map((f) => ({
		value: f.id,
		label: f.name,
	}))
	const serverStateMut = useSDStore().get.serverStateMut()
	const changedSettings = useSDStore().get.changedSettings()

	const sdStore = useSDStore().store()!

	React.useImperativeHandle(ref, () => ({
		reset: (settings) => {
			preferredLengthRef.current!.value = settings.queue.preferredLength.toString()
			preferredNumVoteChoicesRef.current!.value = settings.queue.preferredNumVoteChoices.toString()
		},
	}))

	// async function backfillLayerQueueItems() {
	// 	if (!serverStateMut) return
	// 	const numVoteChoices = serverStateMut.settings.queue.preferredNumVoteChoices
	// 	const numToAdd = serverStateMut.settings.queue.preferredLength - serverStateMut.layerQueue.length
	// 	const itemType = serverStateMut.settings.queue.generatedItemType
	// 	if (numToAdd === 0) return serverStateMut.layerQueue
	// 	if (numToAdd < 0) {
	// 		let lastTrailingGeneratedIdx = -1
	// 		for (let i = serverStateMut.layerQueue.length - 1; i >= serverStateMut?.settings.queue.preferredLength; i--) {
	// 			if (serverStateMut.layerQueue[i].source === 'generated') {
	// 				lastTrailingGeneratedIdx = i
	// 			} else break
	// 		}
	// 		if (lastTrailingGeneratedIdx === -1) {
	// 			return
	// 		}
	// 		return
	// 	}

	// 	const seqIdBefore = serverStateMut.layerQueueSeqId
	// 	const before = deepClone(serverStateMut.layerQueue)
	// 	const generated = await trpc.server.generateLayerQueueItems.query({
	// 		numToAdd,
	// 		numVoteChoices,
	// 		itemType,
	// 		baseFilterId: serverStateMut?.settings.queue.poolFilterId,
	// 	})
	// 	const seqIdAfter = sdStore.get(SDStore.atom.serverState)!.layerQueueSeqId
	// 	if (seqIdBefore !== seqIdAfter || !deepEqual(before, serverStateMut.layerQueue)) return
	// 	sdStore.set(SDStore.atom.addQueueItems, generated)
	// }

	return (
		<Card className="">
			<CardHeader>
				<CardTitle>Pool Configuration</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col space-y-2">
				<div className="flex space-x-1">
					<ComboBox
						title="Pool Filter"
						className="flex-grow"
						options={filterOptions ?? LOADING}
						value={serverStateMut?.settings.queue.poolFilterId}
						onSelect={(filter) =>
							sdStore.set(withImmer(SDStore.atom.serverStateMut), (draft) => {
								draft!.settings.queue.poolFilterId = filter ?? undefined
							})
						}
					/>
					{serverStateMut?.settings.queue.poolFilterId && (
						<a
							className={buttonVariants({ variant: 'ghost', size: 'icon' })}
							target="_blank"
							href={AR.link('/filters/:id/edit', serverStateMut?.settings.queue.poolFilterId)}
						>
							<Edit />
						</a>
					)}
				</div>
				<div className="flex flex-col space-y-1">
					<Label htmlFor={preferredLengthId}>Preferred Queue Length</Label>
					<Input
						type="number"
						ref={preferredLengthRef}
						min="0"
						id={preferredLengthId}
						className="data-[edited=true]:border-edited"
						data-edited={changedSettings?.queue.preferredLength}
						defaultValue={serverStateMut?.settings.queue.preferredLength}
						onChange={(e) => {
							sdStore.set(withImmer(SDStore.atom.serverStateMut), (draft) => {
								draft!.settings.queue.preferredLength = parseInt(e.target.value)
							})
						}}
					/>
				</div>
				<div className="flex flex-col space-y-1">
					<Label htmlFor={preferredNumVoteChoicesId}>Preferred Number of Choices</Label>
					<Input
						type="number"
						ref={preferredNumVoteChoicesRef}
						min="0"
						id={preferredNumVoteChoicesId}
						className="data-[edited=true]:border-edited"
						data-edited={changedSettings?.queue.preferredNumVoteChoices}
						defaultValue={serverStateMut?.settings.queue.preferredNumVoteChoices}
						onChange={(e) => {
							sdStore.set(withImmer(SDStore.atom.serverStateMut), (draft) => {
								draft!.settings.queue.preferredNumVoteChoices = parseInt(e.target.value)
							})
						}}
					/>
				</div>
				<HistoryFilterPanel />
			</CardContent>
			<CardFooter>{/* <Button onClick={() => props.backfillLayerQueueItems()}>Autogenerate queue items</Button> */}</CardFooter>
		</Card>
	)
})

function HistoryFilterPanel(_props: object) {
	const sdStore = useSDStore().store()!
	const serverStateMut = useSDStore().get.serverStateMut()
	const historyFilters = serverStateMut?.historyFilters as EditedHistoryFilterWithId[] | null
	const historyFilterMutations = useSDStore().get.historyFiltersMutations()
	const useHistoryFiltersCheckboxId = React.useId()

	return (
		<div className="flex flex-col space-y-2">
			<h2>History Filters</h2>
			<div className="items-top flex space-x-1 items-center">
				<Checkbox
					checked={serverStateMut?.historyFiltersEnabled}
					onCheckedChange={(checked) => {
						sdStore.set(withImmer(SDStore.atom.serverStateMut), (draft) => {
							if (checked === 'indeterminate') return
							draft!.historyFiltersEnabled = checked
						})
					}}
					id={useHistoryFiltersCheckboxId}
				/>
				<label
					htmlFor={useHistoryFiltersCheckboxId}
					className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
				>
					Enable
				</label>
			</div>
			{historyFilters?.map((filter) => {
				const mutationState = toItemMutationState(historyFilterMutations, filter.id)
				return (
					<HistoryFilter
						key={filter.id}
						filter={filter}
						setFilter={(update) => sdStore.set(SDStore.atom.historyFilterActions.edit, filter.id, update)}
						removeFilter={() => sdStore.set(SDStore.atom.historyFilterActions.remove, filter.id)}
						mutationState={mutationState}
					/>
				)
			})}
			<Button
				onClick={() =>
					sdStore.set(SDStore.atom.historyFilterActions.add, {
						type: 'dynamic',
						column: 'Layer',
						excludeFor: { matches: 10 },
					})
				}
			>
				Add
			</Button>
		</div>
	)
}

function HistoryFilter(props: {
	filter: M.HistoryFilterEdited
	setFilter: React.Dispatch<React.SetStateAction<M.HistoryFilterEdited>>
	removeFilter: () => void
	mutationState: ItemMutationState
}) {
	const setStaticValuesCheckboxId = React.useId()
	const usingStaticValues = props.filter.type === 'static'
	let inner: React.ReactNode
	switch (props.filter.type) {
		case 'dynamic': {
			inner = (
				<ComboBox
					title="Column"
					options={M.COLUMN_TYPE_MAPPINGS.string}
					value={props.filter.column}
					onSelect={(column) => {
						props.setFilter(
							produce((_filter) => {
								const filter = _filter as Extract<M.HistoryFilterEdited, { type: 'dynamic' }>
								filter.column = column as M.LayerColumnKey
							})
						)
					}}
				/>
			)
			break
		}
		case 'static': {
			inner = (
				<Comparison
					comp={props.filter.comparison}
					setComp={(compUpdate) => {
						props.setFilter(
							produce((_filter) => {
								const filter = _filter as Extract<M.HistoryFilterEdited, { type: 'static' }>
								filter.comparison = typeof compUpdate === 'function' ? compUpdate(filter.comparison) : compUpdate
							})
						)
					}}
				/>
			)
			break
		}
		default:
			assertNever(props.filter)
	}
	return (
		<div
			className="flex flex-col space-y-2 border rounded p-2 data-[edited=true]:border-edited data-[added=true]:border-added"
			data-edited={props.mutationState.edited}
			data-added={props.mutationState.added}
		>
			<div className="items-top flex space-x-1 items-center">
				<Checkbox
					checked={usingStaticValues}
					onCheckedChange={(checked) => {
						props.setFilter((_filter) => {
							if (checked === 'indeterminate') return _filter
							if (checked) {
								const existingFilter = _filter as Extract<M.HistoryFilterEdited, { type: 'dynamic' }>
								return {
									...existingFilter,
									type: 'static',
									comparison: {
										column: existingFilter.column,
									},
								}
							} else {
								const existingFilter = _filter as Extract<M.HistoryFilterEdited, { type: 'static' }>
								return {
									...existingFilter,
									type: 'dynamic',
									column: existingFilter.comparison.column ?? 'Layer',
								}
							}
						})
					}}
					id={setStaticValuesCheckboxId}
				/>
				<label
					htmlFor={setStaticValuesCheckboxId}
					className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
				>
					Set static values
				</label>
			</div>
			{inner}
			<div className="flex space-x-1">
				<span>
					<Label htmlFor="excludeFor">Exclude for</Label>
					<Input
						type="number"
						value={props.filter.excludeFor.matches}
						onChange={(e) => {
							props.setFilter(
								produce((filter) => {
									filter.excludeFor.matches = parseInt(e.target.value)
								})
							)
						}}
					/>
				</span>
			</div>
			<Button onClick={() => props.removeFilter()} size="icon" variant="ghost">
				<Minus color="hsl(var(--destructive))" />
			</Button>
		</div>
	)
}

export type QueueItemAction =
	| {
			code: 'edit'
			item: IdedLayerQueueItem
	  }
	| {
			code: 'delete'
			id: string
	  }
	| {
			code: 'add-after' | 'add-before'
			items: M.LayerQueueItem[]
			id?: string
	  }

export function getIndexFromQueueItemId(items: IdedLayerQueueItem[], id: string | null) {
	console.log({ id })
	if (id === null) return -1
	return items.findIndex((item) => item.id === id)
}

type QueueItemProps = {
	index: number
	item: IdedLayerQueueItem
	mutationState: { [key in keyof ItemMutations]: boolean }
	isLast: boolean
	dispatch: React.Dispatch<QueueItemAction>
	allowVotes?: boolean
}

function QueueItem(props: QueueItemProps) {
	const allowVotes = props.allowVotes ?? true
	const draggableItemId = toDraggableItemId(props.item.id)
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: draggableItemId,
	})

	const [dropdownOpen, setDropdownOpen] = useState(false)

	const style = { transform: CSS.Translate.toString(transform) }
	const itemDropdown = (
		<ItemDropdown allowVotes={allowVotes} open={dropdownOpen} setOpen={setDropdownOpen} dispatch={props.dispatch} item={props.item}>
			<Button className="invisible group-hover:visible" variant="ghost" size="icon">
				<EllipsisVertical />
			</Button>
		</ItemDropdown>
	)
	let sourceDisplay: React.ReactNode

	switch (props.item.source) {
		case 'gameserver':
			sourceDisplay = <Badge variant="outline">Game Server</Badge>
			break
		case 'generated':
			sourceDisplay = <Badge variant="outline">Generated</Badge>
			break
		case 'manual':
			sourceDisplay = <Badge variant="outline">Manual</Badge>
			break
		default:
			assertNever(props.item.source)
	}

	const queueItemStyles = `bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30`

	if (props.item.vote) {
		return (
			<>
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
									<li key={choice} className="flex items-center ">
										<span className="mr-2">{index + 1}.</span>
										<span>
											{Helpers.toShortLayerName(layer)}{' '}
											{choice === props.item.vote!.defaultChoice && <Badge variant="outline">default</Badge>}
										</span>
									</li>
								)
							})}
						</ol>
						{sourceDisplay}
					</div>
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</>
		)
	}

	if (props.item.layerId) {
		const layer = M.getMiniLayerFromId(props.item.layerId)
		return (
			<>
				{props.index === 0 && <QueueItemSeparator itemId={toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn(`group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1 min-w-0`, queueItemStyles)}
					data-mutation={getDisplayedMutation(props.mutationState)}
					data-is-dragging={isDragging}
				>
					<Button {...listeners} variant="ghost" size="icon" className="invisible cursor-grab group-hover:visible">
						<GripVertical />
					</Button>
					<div className="flex flex-col w-max flex-grow">
						<div className="flex items-center flex-shrink-0">{Helpers.toShortLayerName(layer)}</div>
						<span>{sourceDisplay}</span>
					</div>
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</>
		)
	}

	throw new Error('Unknown layer queue item layout ' + JSON.stringify(props.item))
}

function ItemDropdown(props: {
	children: React.ReactNode
	item: IdedLayerQueueItem
	dispatch: React.Dispatch<QueueItemAction>
	open: boolean
	setOpen: React.Dispatch<React.SetStateAction<boolean>>
	allowVotes?: boolean
}) {
	const allowVotes = props.allowVotes ?? true
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
	// store which we pass to the locally rendered layer queue for managing a vote layer queue item

	return (
		<DropdownMenu open={dropdownOpen || !!subDropdownState} onOpenChange={setDropdownOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<EditLayerQueueItemPopover
					allowVotes={allowVotes}
					open={subDropdownState === 'edit'}
					onOpenChange={(update) => {
						const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
						return setSubDropdownState(open ? 'edit' : null)
					}}
					item={props.item}
					setItem={(update) => {
						const newItem = typeof update === 'function' ? update(props.item) : update
						props.dispatch({ code: 'edit', item: { ...newItem, id: props.item.id } })
					}}
				>
					<DropdownMenuItem>Edit</DropdownMenuItem>
				</EditLayerQueueItemPopover>

				<SelectLayersPopover
					title="Add layers before"
					description="Select layers to add before"
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
					description="Select layers to add after"
					open={subDropdownState === 'add-after'}
					onOpenChange={(open) => setSubDropdownState(open ? 'add-after' : null)}
					selectQueueItems={(items) => {
						props.dispatch({ code: 'add-after', items, id: props.item.id })
					}}
				>
					<DropdownMenuItem>Add layers after</DropdownMenuItem>
				</SelectLayersPopover>

				<DropdownMenuItem
					onClick={() => {
						props.dispatch({ code: 'delete', id: props.item.id })
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
			className="w-full min-w-0 bg-transparent data-[is-last=true]:invisible data-[is-over=true]:bg-green-400"
			data-is-last={props.isLast && !isOver}
			data-is-over={isOver}
		/>
	)
}

// -------- Queue Mutations --------
type ItemMutations = {
	added: Set<string>
	removed: Set<string>
	moved: Set<string>
	edited: Set<string>
}

type ItemMutationState = { [key in keyof ItemMutations]: boolean }

function toDraggableItemId(id: string | null) {
	return JSON.stringify(id)
}

function fromItemId(serialized: string) {
	return JSON.parse(serialized) as number | null
}
type IdedLayerQueueItem = M.LayerQueueItem & WithMutationId
