import { DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import * as Im from 'immer'
import { Edit, EllipsisVertical, GripVertical, LoaderCircle, PlusIcon } from 'lucide-react'
import deepEqual from 'fast-deep-equal'
import React, { useRef, useState } from 'react'
import { derive } from 'derive-zustand'
import * as AR from '@/app-routes.ts'
import * as FB from '@/lib/filter-builders.ts'
import { toStream } from 'zustand-rx'

import * as Icons from 'lucide-react'
import { flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import * as Helpers from '@/lib/display-helpers'
import * as EFB from '@/lib/editable-filter-builders'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'

import { Comparison } from './filter-card'
import TabsList from './ui/tabs-list.tsx'
import { assertNever } from '@/lib/typeGuards.ts'
import { Checkbox } from './ui/checkbox.tsx'
import { initMutations, initMutationState, tryApplyMutation, WithMutationId } from '@/lib/item-mutations.ts'
import { useLayersGroupedBy } from '@/hooks/use-layer-queries.ts'
import { DropdownMenuItem } from './ui/dropdown-menu.tsx'
import { useLoggedInUser } from '@/hooks/use-logged-in-user.ts'

import * as Zus from 'zustand'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge.tsx'
import { useToast } from '@/hooks/use-toast'
import { trpc } from '@/lib/trpc.client.ts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog.tsx'
import VoteTallyDisplay from './votes-display.tsx'
import { useSquadServerStatus } from '@/hooks/use-squad-server-status.ts'
import { createId } from '@/lib/id.ts'
import { useFilter as useFilterEntity, useFilters } from '@/hooks/filters.ts'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'

import { getDisplayedMutation, hasMutations, toItemMutationState } from '@/lib/item-mutations.ts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { deepClone } from '@/lib/object.ts'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'
import { useConfig } from '@/systems.client/config.client.ts'
import { useAbortVote, useStartVote, useVoteState } from '@/hooks/votes.ts'
import { Getter, Setter } from '@/lib/zustand.ts'
import { useDragEnd } from '@/systems.client/dndkit.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import * as PartsSys from '@/systems.client/parts.ts'
import { combineLatest, map } from 'rxjs'
import { lqServerStateUpdate$ } from '@/hooks/use-layer-queue-state.ts'
import { bind } from '@react-rxjs/core'
import LayerTable from './layer-table.tsx'

type EditedHistoryFilterWithId = M.HistoryFilterEdited & WithMutationId
type MutServerStateWithIds = M.MutableServerState & {
	layerQueue: IdedLLItem[]
	historyFilters: EditedHistoryFilterWithId[]
}

type LLState = {
	layerList: IdedLLItem[]
	listMutations: ItemMutations
}
type LLStore = LLState & LLActions

type LLActions = {
	move: (sourceIndex: number, targetIndex: number, modifiedBy: bigint) => void
	add: (items: M.LayerListItem[], index?: number) => void
	setItem: (id: string, update: React.SetStateAction<IdedLLItem>) => void
	remove: (id: string) => void
}

type LLItemState = { item: IdedLLItem; mutationState: ItemMutationState }
type LLItemStore = LLItemState & LLItemActions

type LLItemActions = {
	setItem: React.Dispatch<React.SetStateAction<IdedLLItem>>
	// if not present then removing is disabled
	remove?: () => void
}

export type _SDState = {
	editedServerState: MutServerStateWithIds
	queueMutations: ItemMutations
	serverState: M.LQServerState | null
}
// computed state
export type SDStore = _SDState & {
	applyServerUpdate: (update: M.LQServerStateUpdate) => void
	reset: () => void
	setSetting: (updater: (settings: Im.Draft<M.ServerSettings>) => void) => void
	setQueue: Setter<LLState>
}

const createLLActions = (set: Setter<LLState>, _get: Getter<LLState>): LLActions => {
	return {
		setItem: (id, update) => {
			set(
				Im.produce((draft) => {
					if (!draft.layerList[id]) return
					draft.layerList[id] = typeof update === 'function' ? update(draft.layerList[id]) : update
					tryApplyMutation('edited', id, draft.listMutations)
				})
			)
		},
		add: (items, index) => {
			set(
				Im.produce((state) => {
					const layerList = state.layerList
					const idedItems = items.map((item) => ({ id: createId(6), ...item }))
					if (index === undefined) {
						layerList.push(...idedItems)
					} else {
						layerList.splice(index, 0, ...idedItems)
					}
					for (const item of idedItems) {
						tryApplyMutation('added', item.id, state.listMutations)
					}
				})
			)
		},
		move: (sourceIndex, targetIndex, modifiedBy) => {
			set((state) =>
				Im.produce(state, (draft) => {
					const layerList = draft.layerList
					const item = layerList[sourceIndex]
					item.lastModifiedBy = modifiedBy
					if (sourceIndex < targetIndex) {
						targetIndex--
					}
					layerList.splice(sourceIndex, 1)
					layerList.splice(targetIndex + 1, 0, item)
					tryApplyMutation('moved', item.id, draft.listMutations)
				})
			)
		},
		remove: (id) => {
			set((state) =>
				Im.produce(state, (state) => {
					const layerList = state.layerList
					const index = layerList.findIndex((item) => item.id === id)
					if (index === -1) return
					layerList.splice(index, 1)
					tryApplyMutation('removed', id, state.listMutations)
				})
			)
		},
	}
}

const selectLLState = (state: _SDState): LLState => ({ layerList: state.editedServerState.layerQueue, listMutations: state.queueMutations })
const createLLStore = (set: Setter<LLState>, get: Getter<LLState>, initialItems: IdedLLItem[]): LLStore => {
	return {
		layerList: initialItems,
		listMutations: initMutations(),
		...createLLActions(set, get),
	}
}
const deriveLLStore = (store: Zus.StoreApi<SDStore>) => {
	const setLL = store.getState().setQueue
	const getLL = () => selectLLState(store.getState())
	const actions = createLLActions(setLL, getLL)

	return derive<LLStore>((get) => {
		return {
			...selectLLState(get(store)),
			...actions,
		}
	})
}

const createLLItemStore = (
	set: Setter<LLItemState>,
	get: Getter<LLItemState>,
	initialState: LLItemState,
	removeItem?: () => void
): LLItemStore => {
	return {
		...initialState,
		setItem: (update) => {
			if (typeof update === 'function') {
				set({ item: update(get().item) })
			} else {
				set({ item: update })
			}
		},
		remove: removeItem,
	}
}

const deriveLLItemStore = (store: Zus.StoreApi<LLStore>, itemId: string) => {
	const actions: LLItemActions = {
		setItem: (update) => store.getState().setItem(itemId, update),
		remove: () => store.getState().remove(itemId),
	}

	return derive<LLItemStore>((get) => ({
		...actions,
		item: get(store).layerList.find((item) => item.id === itemId)!,
		mutationState: toItemMutationState(get(store).listMutations, itemId),
	}))
}

const deriveVoteChoiceListStore = (itemStore: Zus.StoreApi<LLItemStore>) => {
	const actions: LLActions = {
		add: (choiceItems) => {
			const voteChoices = choiceItems.map((item) => item.layerId!)
			itemStore.getState().setItem((prev) =>
				Im.produce(prev, (draft) => {
					if (!draft.vote) return
					draft.vote.choices.push(...voteChoices)
				})
			)
		},
		move: (sourceIndex, targetIndex) => {
			if (sourceIndex === targetIndex || sourceIndex + 1 === targetIndex) return

			itemStore.getState().setItem(
				Im.produce((draft) => {
					if (!draft.vote) return
					const choices = draft.vote.choices
					const choice = choices[sourceIndex]
					if (sourceIndex < targetIndex) {
						targetIndex--
					}
					choices.splice(sourceIndex, 1)
					choices.splice(targetIndex, 0, choice)
				})
			)
		},
		remove: (choiceId) => {
			itemStore.getState().setItem(
				Im.produce((draft) => {
					if (!draft.vote) return
					draft.vote.choices = draft.vote.choices.filter((id) => id !== choiceId)
				})
			)
		},
		setItem: (id, update) => {
			itemStore.getState().setItem((prev) =>
				Im.produce(prev, (draft) => {
					if (!draft.vote) return
					const choiceIndex = draft.vote.choices.findIndex((id) => id === id)
					if (choiceIndex === -1) return
					const existing = draft.vote!.choices[choiceIndex]
					const updatedItem = typeof update === 'function' ? update({ layerId: existing, source: 'manual', id: existing }) : update
					draft.vote!.choices[choiceIndex] = updatedItem.layerId!
				})
			)
		},
	}

	return derive<LLStore>((get) => {
		const vote = get(itemStore).item.vote!
		return {
			layerList: vote.choices.map((layerId): IdedLLItem => ({ id: layerId, layerId, source: 'manual' })),
			listMutations: initMutations(),
			...actions,
		}
	})
}

const _initialState: _SDState = {
	editedServerState: { historyFilters: [], layerQueue: [], layerQueueSeqId: 0, settings: M.ServerSettingsSchema.parse({ queue: {} }) },
	queueMutations: initMutations(),
	serverState: null,
}
function getEditableServerState(state: M.LQServerState): MutServerStateWithIds {
	const layerQueue = state.layerQueue.map((item) => ({ id: createId(6), ...item }))
	const historyFilters = state.historyFilters.map((filter) => ({ ...filter, id: createId(6) }) as M.HistoryFilterEdited & WithMutationId)
	return {
		//@ts-expect-error idk
		historyFilters,
		layerQueue,
		layerQueueSeqId: state.layerQueueSeqId,
		settings: state.settings,
	}
}

const SDStore = Zus.createStore<SDStore>((set, get) => {
	return {
		..._initialState,
		applyServerUpdate: (update) => {
			set({
				editedServerState: getEditableServerState(update.state),
				queueMutations: initMutations(),
			})
		},
		reset: () => {
			const serverStateUpdate = lqServerStateUpdate$.getValue()
			if (!serverStateUpdate) return set(_initialState)

			set({
				..._initialState,
				editedServerState: getEditableServerState(serverStateUpdate.state) ?? _initialState.editedServerState,
			})
		},
		setSetting: (handler) => {
			set((state) =>
				Im.produce(state, (draft) => {
					handler(draft.editedServerState.settings)
				})
			)
		},
		setQueue: (handler) => {
			const updated = typeof handler === 'function' ? handler(selectLLState(get())) : handler
			set({
				editedServerState: {
					...get().editedServerState,
					layerQueue: updated.layerList!,
				},
				queueMutations: updated.listMutations,
			})
		},
	}
})

function selectCurrentPoolFilterId(store: _SDState) {
	return store.editedServerState.settings.queue.poolFilterId
}

const LQStore = deriveLLStore(SDStore)

function selectIsEditing(state: SDStore, serverStateUpdate: M.LQServerStateUpdate | null) {
	if (!serverStateUpdate) return false
	const serverState = serverStateUpdate.state
	const editedServerState = state.editedServerState
	return (serverState && hasMutations(state.queueMutations)) || !deepEqual(serverState.settings, editedServerState.settings)
}

const [useIsEditing] = bind<boolean>(
	combineLatest([toStream(SDStore, (state) => state, { fireImmediately: true }), lqServerStateUpdate$]).pipe(
		map(([state, serverStateUpdate]) => selectIsEditing(state, serverStateUpdate))
	),
	false
)

export default function ServerDashboard() {
	const serverStatus = useSquadServerStatus()
	const settingsPanelRef = useRef<ServerSettingsPanelHandle>(null)

	// ----- notify on pool filter changes -----
	// TODO cleanup
	const poolFilterId = Zus.useStore(SDStore, (s) => s.editedServerState.settings.queue.poolFilterId)
	useFilterEntity(poolFilterId, {
		onUpdate: () => {
			toaster.toast({ title: 'Pool Filter Updated' })
		},
	})

	React.useEffect(() => {
		const sub = lqServerStateUpdate$.subscribe((update) => {
			if (!update) return
			SDStore.getState().applyServerUpdate(update)
		})
		return () => sub.unsubscribe()
	}, [])

	const toaster = useToast()
	const updateQueueMutation = useMutation({
		mutationFn: trpc.layerQueue.updateQueue.mutate,
	})
	// const validatedHistoryFilters = M.histo
	async function saveLqState() {
		const serverStateMut = SDStore.getState().editedServerState
		const res = await updateQueueMutation.mutateAsync(serverStateMut)
		const reset = SDStore.getState().reset
		if (res.code === 'err:next-layer-changed-while-vote-active') {
			toaster.toast({
				title: 'Cannot update: active layer vote in progress',
				variant: 'destructive',
			})
			reset()
		}
		if (res.code === 'err:out-of-sync') {
			toaster.toast({
				title: 'State changed before submission, please try again.',
				variant: 'destructive',
			})
			reset()

			return
		}
		if (res.code === 'ok') {
			reset()
			toaster.toast({ title: 'Changes applied' })
			return
		}
	}

	const [playNextPopoverOpen, setPlayNextPopoverOpen] = useState(false)
	const [appendLayersPopoverOpen, setAppendLayersPopoverOpen] = useState(false)

	const hasVoteState = false

	// TODO implement
	const editing = useIsEditing()
	const queueHasMutations = Zus.useStore(LQStore, (s) => hasMutations(s.listMutations))

	return (
		<div className="contianer mx-auto grid place-items-center py-10">
			<span className="flex space-x-4">
				{hasVoteState && (
					<div>
						<VoteState />
					</div>
				)}
				<div className="flex flex-col space-y-4">
					{/* ------- top card ------- */}
					<Card>
						{!editing && serverStatus?.currentLayer && (
							<>
								<CardHeader>
									<CardTitle>Now Playing</CardTitle>
								</CardHeader>
								<CardContent>{Helpers.displayPossibleUnknownLayer(serverStatus.currentLayer)}</CardContent>
							</>
						)}
						{!editing && !serverStatus?.currentLayer && <p className={Typography.P}>No active layer found</p>}
						{editing && (
							<div className="flex flex-col space-y-2">
								<Card>
									<CardHeader>
										<CardTitle>Changes Pending</CardTitle>
									</CardHeader>
									<CardContent>{queueHasMutations && <EditSummary />}</CardContent>
									<CardFooter className="space-x-1">
										<Button onClick={saveLqState} disabled={updateQueueMutation.isPending}>
											Save Changes
										</Button>
										<Button onClick={() => SDStore.getState().reset()} variant="secondary">
											Cancel
										</Button>
										<LoaderCircle className="animate-spin data-[pending=false]:invisible" data-pending={updateQueueMutation.isPending} />
									</CardFooter>
								</Card>
							</div>
						)}
					</Card>
					<Card className="">
						<CardHeader className="flex flex-row items-center justify-between">
							<CardTitle>Up Next</CardTitle>
							<div className="flex items-center space-x-1">
								<SelectLayersPopover
									title="Add to Queue"
									description="Select layers to add to the queue"
									selectQueueItems={(items) => LQStore.getState().add(items)}
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
									selectQueueItems={(items) => LQStore.getState().add(items, 0)}
									open={playNextPopoverOpen}
									onOpenChange={setPlayNextPopoverOpen}
								>
									<Button className="flex w-min items-center space-x-1" variant="default">
										<PlusIcon />
										<span>Play Next</span>
									</Button>
								</SelectLayersPopover>
							</div>
						</CardHeader>
						<CardContent>
							<ScrollArea>
								<LayerList store={LQStore} allowVotes={true} />
							</ScrollArea>
						</CardContent>
					</Card>
				</div>
				<div>
					<ServerSettingsPanels ref={settingsPanelRef} />
				</div>
			</span>
		</div>
	)
}

function EditSummary() {
	const queueMutations = Zus.useStore(SDStore, (s) => s.queueMutations)
	return (
		<>
			<h3>Layer Changes pending</h3>
			<span className="flex space-x-1">
				{queueMutations.added.size > 0 && <Badge variant="added">{queueMutations.added.size} added</Badge>}
				{queueMutations.removed.size > 0 && <Badge variant="removed">{queueMutations.removed.size} deleted</Badge>}
				{queueMutations.moved.size > 0 && <Badge variant="moved">{queueMutations.moved.size} moved</Badge>}
				{queueMutations.edited.size > 0 && <Badge variant="edited">{queueMutations.edited.size} edited</Badge>}
			</span>
		</>
	)
}

// TODO the atoms relevant to LayerQueue should be abstracted into a separate store at some point, for expediency we're just going to call the same atoms under a different store
export function LayerList(props: { store: Zus.StoreApi<LLStore>; allowVotes?: boolean }) {
	const userQuery = useLoggedInUser()
	const allowVotes = props.allowVotes ?? true
	const queueIds = Zus.useStore(props.store).layerList.map((item) => item.id)
	useDragEnd((event) => {
		const { layerList: layerQueue, move } = props.store.getState()
		const sourceIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.active.id as string))
		const targetIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.over!.id as string))
		if (!userQuery.data) return
		move(sourceIndex, targetIndex, userQuery.data.discordId)
	})

	return (
		<ul className="flex w-max flex-col space-y-1">
			{/* -------- queue items -------- */}
			{queueIds.map((id, index) => (
				<LayerListItem
					llStore={props.store}
					allowVotes={allowVotes}
					key={id}
					id={id}
					index={index}
					isLast={index + 1 === queueIds.length}
				/>
			))}
		</ul>
	)
}

// TODO this is all kinds of fucked up
function VoteState() {
	const abortVoteMutation = useAbortVote()
	const toaster = useToast()
	const voteState = useVoteState()

	async function abortVote() {
		const serverStateMut = SDStore.getState().editedServerState
		if (!serverStateMut?.layerQueueSeqId) return
		const res = await abortVoteMutation.mutateAsync()

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

	const startVoteMutation = useStartVote()
	const openDialog = useAlertDialog()
	let body: React.ReactNode

	const slmConfig = useConfig()
	const [voteConfig, setVoteConfig] = React.useState({
		duration: slmConfig?.defaults.voteDurationSeconds ?? 30,
	})

	async function startVote() {
		const res = await startVoteMutation.mutateAsync({ durationSeconds: voteConfig.duration })
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
		const res = await startVoteMutation.mutateAsync({ durationSeconds: voteConfig.duration, restart: true })
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

	if (!voteState) return null

	const voteConfigElt = (
		<div className="flex flex-col space-y-2">
			<div>
				<Label>Vote Duration (seconds)</Label>
				<Input
					type="number"
					min="0"
					defaultValue={voteConfig.duration}
					onChange={(e) => setVoteConfig((prev) => ({ ...prev, duration: parseInt(e.target.value) }))}
				/>
			</div>
		</div>
	)

	const rerunVoteBtn = (
		<Button
			onClick={async () => {
				const id = await openDialog({
					title: 'Rerun Vote',
					description: 'Are you sure you want to return the vote?',
					buttons: [{ label: 'Rerun Vote', id: 'confirm' }],
				})
				if (id === 'confirm') rerunVote()
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
					if (id === 'confirm') abortVote()
				})
			}}
			variant="secondary"
		>
			Cancel Vote
		</Button>
	)

	switch (voteState.code) {
		case 'ready':
			body = (
				<>
					<Button
						onClick={async () => {
							const id = await openDialog({
								title: 'Start Vote',
								description: 'Are you sure you want to start the vote?',
								buttons: [{ label: 'Start Vote', id: 'confirm' }],
							})
							if (id === 'confirm') startVote()
						}}
					>
						Start Vote
					</Button>
					{voteConfigElt}
				</>
			)
			break
		case 'in-progress':
			{
				body = (
					<>
						<Timer deadline={voteState.deadline} />
						<VoteTallyDisplay voteState={voteState} />
						{rerunVoteBtn}
						{cancelBtn}
					</>
				)
			}
			break
		case 'ended:winner':
			body = (
				<>
					<span>winner: {Helpers.toShortLayerNameFromId(voteState.winner)}</span>
					<VoteTallyDisplay voteState={voteState} />
					{rerunVoteBtn}
					{voteConfigElt}
				</>
			)
			break
		case 'ended:aborted': {
			const user = voteState.aborter.discordId && PartsSys.findUser(voteState.aborter.discordId)
			body = (
				<>
					<Alert>
						<AlertTitle>Vote Aborted</AlertTitle>
						{user ? (
							<AlertDescription>Vote was manually aborted by {user.username}</AlertDescription>
						) : (
							<AlertDescription>Vote was Aborted</AlertDescription>
						)}
					</Alert>
					<VoteTallyDisplay voteState={voteState} />
					{rerunVoteBtn}
					{voteConfigElt}
				</>
			)
			break
		}
		case 'ended:insufficient-votes': {
			body = (
				<>
					<Alert variant="destructive">
						<AlertTitle>Vote Aborted</AlertTitle>
						<AlertDescription>Vote was aborted due to insufficient votes</AlertDescription>
					</Alert>
					{rerunVoteBtn}
					{voteConfigElt}
				</>
			)
			break
		}
		default:
			assertNever(voteState)
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Vote</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col space-y-2">{body}</CardContent>
		</Card>
	)
}

function FilterEntitySelect(props: {
	className?: string
	title: string
	filterId: string | null
	onSelect: (filterId: string | null) => void
}) {
	const filtersRes = useFilters()

	const filterOptions = filtersRes.data?.map?.((f) => ({
		value: f.id,
		label: f.name,
	}))

	return (
		<div className={cn('flex space-x-2 items-center', props.className)}>
			<ComboBox
				title="Filter"
				className="flex-grow"
				options={filterOptions ?? LOADING}
				allowEmpty={true}
				value={props.filterId}
				onSelect={(filter) => props.onSelect(filter ?? null)}
			/>
			{props.filterId && (
				<a
					className={buttonVariants({ variant: 'ghost', size: 'icon' })}
					target="_blank"
					href={AR.link('/filters/:id/edit', props.filterId)}
				>
					<Edit />
				</a>
			)}
		</div>
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
const ServerSettingsPanels = React.forwardRef(function ServerSettingsPanel(
	props: object,
	ref: React.ForwardedRef<ServerSettingsPanelHandle>
) {
	const filtersRes = useQuery({
		queryKey: ['filters'],
		queryFn: () => trpc.filters.getFilters.query(),
	})

	const filterOptions = filtersRes.data?.map?.((f) => ({
		value: f.id,
		label: f.name,
	}))

	React.useImperativeHandle(ref, () => ({
		reset: () => {},
	}))
	const changedSettings = Zus.useStore(SDStore, (s) => {
		if (!s.serverState) return null
		return M.getSettingsChanged(s.serverState.settings, s.editedServerState.settings)
	})
	const settings = Zus.useStore(SDStore, (s) => s.editedServerState.settings)
	const setSetting = Zus.useStore(SDStore, (s) => s.setSetting)
	return (
		<div className="flex flex-col space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>Pool Configuration</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col space-y-2">
					<div
						className="flex space-x-1 p-1 data-[edited=true]:bg-edited data-[edited=true]:border-edited rounded"
						data-edited={changedSettings?.queue.poolFilterId}
					>
						<ComboBox
							title="Pool Filter"
							className="flex-grow"
							options={filterOptions ?? LOADING}
							value={settings.queue.poolFilterId}
							onSelect={(filter) =>
								setSetting((settings) => {
									settings.queue.poolFilterId = filter ?? undefined
								})
							}
						/>
						{settings.queue.poolFilterId && (
							<a
								className={buttonVariants({ variant: 'ghost', size: 'icon' })}
								target="_blank"
								href={AR.link('/filters/:id/edit', settings.queue.poolFilterId)}
							>
								<Edit />
							</a>
						)}
					</div>
				</CardContent>
				<CardFooter></CardFooter>
			</Card>
			<QueueGenerationCard />
			{/* {featureFlags.historyFilters && <HistoryFilterPanel />} */}
		</div>
	)
})

function QueueGenerationCard() {
	const [numItemsToGenerate, setNumItemsToGenerate] = React.useState(5)
	const numItemsToGenerateId = React.useId()

	const [itemType, setItemType] = React.useState<'layer' | 'vote'>('layer')
	const [replaceCurrentGenerated, setReplaceCurrentGenerated] = React.useState(false)
	const itemTypeId = React.useId()
	const [numVoteChoices, setNumVoteChoices] = React.useState(3)
	const numVoteChoicesRef = React.useRef<HTMLInputElement>(null)
	const numVoteChoicesId = React.useId()

	const genereateMutation = useMutation({
		mutationFn: generateLayerQueueItems,
	})
	async function generateLayerQueueItems() {
		let serverStateMut = SDStore.getState().editedServerState
		const numVoteChoices = serverStateMut.settings.queue.preferredNumVoteChoices
		const seqIdBefore = serverStateMut.layerQueueSeqId
		const before = deepClone(serverStateMut.layerQueue)
		const generated = await trpc.layerQueue.generateLayerQueueItems.query({
			numToAdd: numItemsToGenerate,
			numVoteChoices,
			itemType,
			baseFilterId: serverStateMut?.settings.queue.poolFilterId,
		})

		const seqIdAfter = SDStore.getState().editedServerState.layerQueueSeqId
		if (seqIdBefore !== seqIdAfter || !deepEqual(before, serverStateMut.layerQueue)) return

		// this technically should be unnecessary, but just in case
		serverStateMut = SDStore.getState().editedServerState

		if (replaceCurrentGenerated) {
			// Remove generated items from end of queue
			while (
				serverStateMut.layerQueue.length > 0 &&
				serverStateMut.layerQueue[serverStateMut.layerQueue.length - 1].source === 'generated'
			) {
				LQStore.getState().remove(serverStateMut.layerQueue[serverStateMut.layerQueue.length - 1].id)
			}
		}

		LQStore.getState().add(generated)
	}

	return (
		<Card className="flex flex-col space-y-1">
			<CardHeader>
				<CardTitle>Queue Generation</CardTitle>
			</CardHeader>
			<CardContent className="space-y-2">
				<div className="flex flex-col items-start space-y-1">
					<Label htmlFor={itemTypeId}>Item Type</Label>
					<ToggleGroup
						value={itemType}
						onValueChange={(v) => {
							setItemType(v as 'layer' | 'vote')
						}}
						type="single"
						id={itemTypeId}
					>
						<ToggleGroupItem value="layer">Layer</ToggleGroupItem>
						<ToggleGroupItem value="vote">Vote</ToggleGroupItem>
					</ToggleGroup>
				</div>
				<div className="flex flex-col items-start space-y-1">
					<Label htmlFor={numItemsToGenerateId}>Num of items to generate</Label>
					<Input
						type="number"
						id={numItemsToGenerateId}
						min="1"
						defaultValue={numItemsToGenerate}
						onChange={(e) => {
							setNumItemsToGenerate(parseInt(e.target.value) ?? 0)
						}}
					/>
				</div>
				{itemType === 'vote' && (
					<div>
						<Label htmlFor={numVoteChoicesId}>Num of vote choices</Label>
						<Input
							type="number"
							id={numVoteChoicesId}
							min="1"
							defaultValue={numVoteChoices}
							onChange={(e) => {
								setNumVoteChoices(parseInt(e.target.value) ?? 0)
							}}
						/>
					</div>
				)}
				<div className="flex space-x-2">
					<Button disabled={genereateMutation.isPending} onClick={() => genereateMutation.mutateAsync()}>
						Generate
					</Button>
					<LoaderCircle className="animate-spin data-[pending=false]:invisible" data-pending={genereateMutation.isPending} />
				</div>
			</CardContent>
		</Card>
	)
}

// function HistoryFilterPanel(_props: object) {
// 	const sdStore = useSDStore().store()!
// 	const serverStateMut = useSDStore().get.serverStateMut()
// 	const serverState = useSDStore().get.serverState()
// 	const historyFilters = serverStateMut?.historyFilters as EditedHistoryFilterWithId[] | null
// 	const historyFilterMutations = useSDStore().get.historyFiltersMutations()
// 	const useHistoryFiltersCheckboxId = React.useId()
// 	const historyFilterEnabledChanged =
// 		serverStateMut?.settings.queue.historyFilterEnabled !== serverState?.settings.queue.historyFilterEnabled

// 	return (
// 		<Card>
// 			<CardHeader>
// 				<CardTitle>History Filters</CardTitle>
// 				<div
// 					className="w-min p-1 items-top flex space-x-1 items-center data-[changed=true]:bg-edited rounded"
// 					data-changed={historyFilterEnabledChanged}
// 				>
// 					<Checkbox
// 						checked={serverStateMut?.settings.queue.historyFilterEnabled}
// 						onCheckedChange={(checked) => {
// 							sdStore.set(withImmer(SDStore.atom.serverStateMut), (draft) => {
// 								if (checked === 'indeterminate') return
// 								draft!.settings.queue.historyFilterEnabled = checked
// 							})
// 						}}
// 						id={useHistoryFiltersCheckboxId}
// 					/>
// 					<label
// 						htmlFor={useHistoryFiltersCheckboxId}
// 						className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
// 					>
// 						Enable
// 					</label>
// 				</div>
// 			</CardHeader>
// 			<CardContent>
// 				{historyFilters?.map((filter) => {
// 					const mutationState = toItemMutationState(historyFilterMutations, filter.id)
// 					return (
// 						<HistoryFilter
// 							key={filter.id}
// 							filter={filter}
// 							setFilter={(update) => sdStore.set(SDStore.atom.historyFilterActions.edit, filter.id, update)}
// 							removeFilter={() => sdStore.set(SDStore.atom.historyFilterActions.remove, filter.id)}
// 							mutationState={mutationState}
// 						/>
// 					)
// 				})}
// 			</CardContent>
// 			<CardFooter>
// 				<Button
// 					onClick={() =>
// 						sdStore.set(SDStore.atom.historyFilterActions.add, {
// 							type: 'dynamic',
// 							column: 'Layer',
// 							excludeFor: { matches: 10 },
// 						})
// 					}
// 				>
// 					Add History Filter
// 				</Button>
// 			</CardFooter>
// 		</Card>
// 	)
// }

// function HistoryFilter(props: {
// 	filter: M.HistoryFilterEdited
// 	setFilter: React.Dispatch<React.SetStateAction<M.HistoryFilterEdited>>
// 	removeFilter: () => void
// 	mutationState: ItemMutationState
// }) {
// 	const setStaticValuesCheckboxId = React.useId()
// 	const usingStaticValues = props.filter.type === 'static'
// 	let inner: React.ReactNode
// 	switch (props.filter.type) {
// 		case 'dynamic': {
// 			inner = (
// 				<ComboBox
// 					title="Column"
// 					options={M.COLUMN_TYPE_MAPPINGS.string}
// 					value={props.filter.column}
// 					onSelect={(column) => {
// 						props.setFilter(
// 							Im.produce((_filter) => {
// 								const filter = _filter as Extract<M.HistoryFilterEdited, { type: 'dynamic' }>
// 								filter.column = column as M.LayerColumnKey
// 							})
// 						)
// 					}}
// 				/>
// 			)
// 			break
// 		}
// 		case 'static': {
// 			inner = (
// 				<Comparison
// 					comp={props.filter.comparison}
// 					setComp={(compUpdate) => {
// 						props.setFilter(
// 							Im.produce((_filter) => {
// 								const filter = _filter as Extract<M.HistoryFilterEdited, { type: 'static' }>
// 								filter.comparison = typeof compUpdate === 'function' ? compUpdate(filter.comparison) : compUpdate
// 							})
// 						)
// 					}}
// 				/>
// 			)
// 			break
// 		}
// 		default:
// 			assertNever(props.filter)
// 	}
// 	const excludeForId = React.useId()
// 	return (
// 		<div
// 			className="flex flex-col space-y-2 border rounded p-2 data-[edited=true]:border-edited data-[added=true]:border-added"
// 			data-edited={props.mutationState.edited}
// 			data-added={props.mutationState.added}
// 		>
// 			<div className="items-top flex space-x-1 items-center">
// 				<Checkbox
// 					checked={usingStaticValues}
// 					onCheckedChange={(checked) => {
// 						props.setFilter((_filter) => {
// 							if (checked === 'indeterminate') return _filter
// 							if (checked) {
// 								const existingFilter = _filter as Extract<M.HistoryFilterEdited, { type: 'dynamic' }>
// 								return {
// 									...existingFilter,
// 									type: 'static',
// 									comparison: {
// 										column: existingFilter.column,
// 									},
// 								} satisfies M.HistoryFilterEdited
// 							} else {
// 								const existingFilter = _filter as Extract<M.HistoryFilterEdited, { type: 'static' }>
// 								return {
// 									...existingFilter,
// 									type: 'dynamic',
// 									column: existingFilter.comparison.column ?? 'Layer',
// 								} satisfies M.HistoryFilterEdited
// 							}
// 						})
// 					}}
// 					id={setStaticValuesCheckboxId}
// 				/>
// 				<label
// 					htmlFor={setStaticValuesCheckboxId}
// 					className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
// 				>
// 					Set static values
// 				</label>
// 			</div>
// 			{inner}
// 			<div className="flex space-x-1">
// 				<span>
// 					<Label htmlFor={excludeForId}>Exclude for matches:</Label>
// 					<Input
// 						id={excludeForId}
// 						type="number"
// 						value={props.filter.excludeFor.matches}
// 						onChange={(e) => {
// 							props.setFilter(
// 								Im.produce((filter) => {
// 									filter.excludeFor.matches = parseInt(e.target.value)
// 								})
// 							)
// 						}}
// 					/>
// 				</span>
// 			</div>
// 			<Button onClick={() => props.removeFilter()} size="icon" variant="ghost">
// 				<Minus color="hsl(var(--destructive))" />
// 			</Button>
// 		</div>
// 	)
// }

export type QueueItemAction =
	| {
			code: 'move'
			sourceId: string
			destinationId: string
	  }
	| {
			code: 'edit'
			item: IdedLLItem
	  }
	| {
			code: 'delete'
			id: string
	  }
	| {
			code: 'add-after' | 'add-before'
			items: M.LayerListItem[]
			id?: string
	  }

function getIndexFromQueueItemId(items: IdedLLItem[], id: string | null) {
	if (id === null) return -1
	return items.findIndex((item) => item.id === id)
}

type QueueItemProps = {
	index: number
	isLast: boolean
	allowVotes?: boolean
	id: string
	llStore: Zus.StoreApi<LLStore>
}

function LayerListItem(props: QueueItemProps) {
	const itemStore = React.useMemo(() => deriveLLItemStore(props.llStore, props.id), [props.llStore, props.id])
	const allowVotes = props.allowVotes ?? true
	const item = Zus.useStore(itemStore, (s) => s.item)
	const draggableItemId = toDraggableItemId(item.id)
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: draggableItemId,
	})

	const [dropdownOpen, setDropdownOpen] = useState(false)
	// const voteStore = React.useMemo(() => {
	// 	return derive<LQStore>((get) => {
	// 		const state = selectVoteLQState(props.id, get(props.store))
	// 		return {
	// 			...state,
	// 			itemActions.
	// 		}
	// 	})
	// }, [props.store, props.id, voteListActions])

	const style = { transform: CSS.Translate.toString(transform) }
	const itemDropdown = (
		<ItemDropdown
			allowVotes={allowVotes}
			index={props.index}
			open={dropdownOpen}
			setOpen={setDropdownOpen}
			listStore={props.llStore}
			itemStore={itemStore}
		>
			<Button className="invisible group-hover:visible" variant="ghost" size="icon">
				<EllipsisVertical />
			</Button>
		</ItemDropdown>
	)
	let sourceDisplay: React.ReactNode
	const modifiedBy = item.lastModifiedBy && PartsSys.findUser(item.lastModifiedBy)
	const modifiedByDisplay = modifiedBy ? `- ${modifiedBy.username}` : ''

	switch (item.source) {
		case 'gameserver':
			sourceDisplay = <Badge variant="outline">Game Server</Badge>
			break
		case 'generated':
			sourceDisplay = <Badge variant="outline">Generated {modifiedByDisplay}</Badge>
			break
		case 'manual': {
			sourceDisplay = <Badge variant="outline">Manual {modifiedByDisplay}</Badge>
			break
		}
		default:
			assertNever(item.source)
	}

	const queueItemStyles = `bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30`
	const squadServerNextLayer = useSquadServerStatus()?.nextLayer

	const notCurrentNextLayer = props.index === 0 && squadServerNextLayer?.code === 'unknown' && (
		<Tooltip>
			<TooltipTrigger>
				<Badge variant="destructive">?</Badge>
			</TooltipTrigger>
			<TooltipContent>Not current next layer on server, layer set on server is unknown to squad-layer-manager</TooltipContent>
		</Tooltip>
	)
	const displayedMutation = Zus.useStore(itemStore, (s) => getDisplayedMutation(s.mutationState))

	if (item.vote) {
		return (
			<>
				{props.index === 0 && <QueueItemSeparator itemId={toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn('group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1', queueItemStyles)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					<div className="flex items-center">
						<Button {...listeners} variant="ghost" size="icon" className="invisible cursor-grab group-hover:visible">
							<GripVertical />
						</Button>
					</div>
					<div className="h-full flex flex-col flex-grow">
						<label className={Typography.Muted}>Vote</label>
						<ol className={'flex flex-col space-y-1 items-start'}>
							{item.vote.choices.map((choice, index) => {
								const layer = M.getMiniLayerFromId(choice)
								return (
									<li key={choice} className="flex items-center ">
										<span className="mr-2">{index + 1}.</span>
										<span>
											{Helpers.toShortLayerName(layer)} {choice === item.vote!.defaultChoice && <Badge variant="outline">default</Badge>}
											{choice === item.layerId && <Badge variant="added">chosen</Badge>}
										</span>
									</li>
								)
							})}
						</ol>
						<div>{sourceDisplay}</div>
						{notCurrentNextLayer}
					</div>
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</>
		)
	}

	if (item.layerId) {
		const layer = M.getMiniLayerFromId(item.layerId)
		return (
			<>
				{props.index === 0 && <QueueItemSeparator itemId={toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn(`group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1 min-w-0`, queueItemStyles)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					<Button {...listeners} variant="ghost" size="icon" className="invisible cursor-grab group-hover:visible">
						<GripVertical />
					</Button>
					<div className="flex flex-col w-max flex-grow">
						<div className="flex items-center flex-shrink-0">{Helpers.toShortLayerName(layer)}</div>
						<span>{sourceDisplay}</span>
						{notCurrentNextLayer}
					</div>
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</>
		)
	}
	throw new Error('Unknown layer queue item layout ' + JSON.stringify(item))
}

function ItemDropdown(props: {
	children: React.ReactNode
	index: number
	open: boolean
	setOpen: React.Dispatch<React.SetStateAction<boolean>>
	itemStore: Zus.StoreApi<LLItemStore>
	listStore: Zus.StoreApi<LLStore>
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

	return (
		<DropdownMenu open={dropdownOpen || !!subDropdownState} onOpenChange={setDropdownOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<EditLayerQueueItemDialogWrapper
					allowVotes={allowVotes}
					open={subDropdownState === 'edit'}
					onOpenChange={(update) => {
						const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
						return setSubDropdownState(open ? 'edit' : null)
					}}
					itemStore={props.itemStore}
				>
					<DropdownMenuItem>Edit</DropdownMenuItem>
				</EditLayerQueueItemDialogWrapper>

				<SelectLayersPopover
					title="Add layers before"
					description="Select layers to add before"
					open={subDropdownState === 'add-before'}
					onOpenChange={(open) => setSubDropdownState(open ? 'add-before' : null)}
					selectingSingleLayerQueueItem={true}
					selectQueueItems={(items) => {
						const state = props.listStore.getState()
						state.add(items, props.index)
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
						const state = props.listStore.getState()
						state.add(items, props.index + 1)
					}}
				>
					<DropdownMenuItem>Add layers after</DropdownMenuItem>
				</SelectLayersPopover>

				<DropdownMenuItem
					onClick={() => {
						const id = props.itemStore.getState().item.id
						props.listStore.getState().remove(id)
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

type SelectMode = 'vote' | 'layers'

export function SelectLayersPopover(props: {
	title: string
	description: React.ReactNode
	pinMode?: SelectMode
	children: React.ReactNode
	selectQueueItems: (queueItems: M.LayerListItem[]) => void
	defaultSelected?: M.LayerId[]
	selectingSingleLayerQueueItem?: boolean
	open: boolean
	onOpenChange: (isOpen: boolean) => void
}) {
	const defaultSelected: M.LayerId[] = props.defaultSelected ?? []

	const poolFilterId = Zus.useStore(SDStore, selectCurrentPoolFilterId)
	const [selectedFilterId, setSelectedFilterId] = React.useState<M.FilterEntityId | null>(poolFilterId ?? null)
	const filterEntity = useFilterEntity(selectedFilterId ?? undefined).data
	const filterMenuStore = useFilterMenuStore(filterEntity?.filter)

	const [selectedLayers, setSelectedLayers] = React.useState<M.LayerId[]>(defaultSelected)
	const [selectMode, _setSelectMode] = React.useState<SelectMode>(props.pinMode ?? 'layers')
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
	const loggedInUserRes = useLoggedInUser()

	const canSubmit = selectedLayers.length > 0
	function submit(e: React.FormEvent) {
		e.preventDefault()
		e.stopPropagation()
		if (!canSubmit) return
		if (selectMode === 'layers') {
			const items: M.LayerListItem[] = selectedLayers.map(
				(layerId) =>
					({
						layerId: layerId,
						source: 'manual',
						lastModifiedBy: loggedInUserRes.data!.discordId,
					}) satisfies M.LayerListItem
			)
			props.selectQueueItems(items)
		} else if (selectMode === 'vote') {
			const item: M.LayerListItem = {
				vote: {
					choices: selectedLayers,
					defaultChoice: selectedLayers[0],
				},
				source: 'manual',
				lastModifiedBy: loggedInUserRes.data!.discordId,
			}
			props.selectQueueItems([item])
		}
		onOpenChange(false)
	}

	function onOpenChange(open: boolean) {
		if (open) {
			setSelectedLayers(defaultSelected)
		}
		props.onOpenChange(open)
	}

	return (
		<Dialog open={props.open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0">
				<form className="h-full w-full" onSubmit={submit}>
					<DialogHeader>
						<DialogTitle>{props.title}</DialogTitle>
						<DialogDescription>{props.description}</DialogDescription>
						<div className="flex items-center w-full space-x-2">
							<p className={Typography.P}>{selectedLayers.length} layers selected</p>
							{!props.pinMode && (
								<TabsList
									options={[
										{ label: 'Vote', value: 'vote' },
										{ label: 'Layers', value: 'layers' },
									]}
									active={selectMode}
									setActive={setAdditionType}
								/>
							)}
						</div>
					</DialogHeader>
					<div>
						<FilterEntitySelect title="Choose Filter" filterId={selectedFilterId} onSelect={setSelectedFilterId} />
					</div>

					<div className="flex min-h-0 items-center space-x-2">
						<LayerFilterMenu filterMenuStore={filterMenuStore} />
						<ListStyleLayerPicker
							filter={filterMenuStore.filter}
							defaultSelected={selectedLayers}
							select={setSelectedLayers}
							pickerMode={selectMode === 'vote' ? 'toggle' : 'add'}
						/>
					</div>

					<DialogFooter>
						<Button disabled={!canSubmit} type="submit">
							Submit
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

function ListStyleLayerPicker(props: {
	filter?: M.FilterNode
	defaultSelected?: M.LayerId[]
	select: React.Dispatch<React.SetStateAction<M.LayerId[]>>
	pickerMode: 'toggle' | 'single'
}) {
	const [selectedLayers, setSelectedLayers] = React.useState<M.LayerId[]>([])

	const setSelected: React.Dispatch<React.SetStateAction<M.LayerId[]>> = (newSelected) => {
		debugger
		setSelectedLayers(newSelected)
	}
	const [pageIndex, setPageIndex] = React.useState(0)
	return (
		<div className="flex h-full">
			<LayerTable
				// filter={props.filter}
				pageIndex={pageIndex}
				setPageIndex={setPageIndex}
				selected={selectedLayers}
				setSelected={setSelected}
				// maxSelected={props.pickerMode === 'single' ? 1 : undefined}
				// defaultSortBy="random"
				// defaultColumns={['Level', 'Gamemode', 'LayerVersion', 'FullMatchup', 'Asymmetry_Score', 'Balance_Differential']}
				// defaultSortDirection="DESC"
			/>
		</div>
	)
}

function itemToLayers(item: M.LayerListItem): M.MiniLayer[] {
	let layers: M.MiniLayer[]
	if (item.vote) {
		layers = item.vote.choices.map((choice) => M.getMiniLayerFromId(choice))
	} else if (item.layerId) {
		layers = [M.getMiniLayerFromId(item.layerId)]
	} else {
		throw new Error('Invalid LayerQueueItem')
	}
	return layers
}

type EditLayerQueueItemDialogProps = {
	children: React.ReactNode
} & InnerEditLayerQueueItemDialogProps

type InnerEditLayerQueueItemDialogProps = {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	allowVotes?: boolean
	itemStore: Zus.StoreApi<LLItemStore>
}

function EditLayerQueueItemDialogWrapper(props: EditLayerQueueItemDialogProps) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0">
				<DragContextProvider>
					<EditLayerListItemDialog {...props} />
				</DragContextProvider>
			</DialogContent>
		</Dialog>
	)
}

export function EditLayerListItemDialog(props: InnerEditLayerQueueItemDialogProps) {
	const allowVotes = props.allowVotes ?? true

	const initialItem = Zus.useStore(props.itemStore, (s) => s.item)
	const poolFilterId = Zus.useStore(SDStore, (s) => s.editedServerState.settings.queue.poolFilterId)

	const editedItemStore = React.useMemo(() => {
		return Zus.create<LLItemStore>((set, get) => createLLItemStore(set, get, { item: initialItem, mutationState: initMutationState() }))
	}, [initialItem])
	const editedItem = Zus.useStore(editedItemStore, (s) => s.item)

	const derivedVoteChoiceStore = React.useMemo(() => deriveVoteChoiceListStore(editedItemStore), [editedItemStore])

	const user = useLoggedInUser().data

	useDragEnd((event) => {
		const layerQueue = editedItem.vote?.choices.map((id): M.LayerListItem & WithMutationId => ({ id, layerId: id, source: 'manual' })) ?? []
		if (!editedItem.vote || !event.over) return
		const sourceIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.active.id as string))
		const targetIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.over?.id as string))

		if (sourceIndex === targetIndex || targetIndex + 1 === sourceIndex || !user) return
		derivedVoteChoiceStore.getState().move(sourceIndex, targetIndex, user.discordId)
	})

	const [addLayersOpen, setAddLayersOpen] = React.useState(false)

	const filtersRes = useFilters()
	const [selectedBaseFilter, setSelectedBaseFilter] = React.useState<M.FilterEntityId | null>(poolFilterId ?? null)
	const baseFilterEntity = filtersRes.data?.find((f) => f.id === selectedBaseFilter)
	const filterMenuStore = useFilterMenuStore(baseFilterEntity?.filter)

	const canSubmit = Zus.useStore(
		editedItemStore,
		(s) => !deepEqual(initialItem, s.item) && (!s.item.vote || s.item.vote.choices.length > 0)
	)
	function submit(e: React.FormEvent) {
		e.preventDefault()
		e.stopPropagation()
		if (!canSubmit) return
		props.onOpenChange(false)
	}

	if (!props.allowVotes && editedItem.vote) throw new Error('Invalid queue item')

	return (
		<form className="w-full h-full" onSubmit={submit}>
			<DialogHeader>
				<div className="flex justify-between mr-6">
					<div className="flex flex-col">
						<DialogTitle>Edit</DialogTitle>
						<DialogDescription>Change the layer or vote choices for this queue item.</DialogDescription>
					</div>
					{allowVotes && (
						<TabsList
							options={[
								{ label: 'Vote', value: 'vote' },
								{ label: 'Set Layer', value: 'layer' },
							]}
							active={editedItem.vote ? 'vote' : 'layer'}
							setActive={(itemType) => {
								editedItemStore.getState().setItem((prev) => {
									const selectedLayers = itemToLayers(prev)
									const attribution = {
										source: 'manual' as const,
										lastModifiedBy: user!.discordId,
									}
									if (itemType === 'vote') {
										return {
											id: prev.id,
											vote: {
												choices: selectedLayers.map((l) => l.id),
												defaultChoice: selectedLayers[0].id,
											},
											...attribution,
										}
									} else if (itemType === 'layer') {
										return {
											id: prev.id,
											layerId: selectedLayers[0].id,
											...attribution,
										}
									} else {
										assertNever(itemType)
									}
								})
							}}
						/>
					)}
				</div>
			</DialogHeader>

			<div className="flex items-center mb-2">
				<FilterEntitySelect
					title="Filter"
					className="max-w-16"
					filterId={selectedBaseFilter}
					onSelect={(id) => setSelectedBaseFilter(id)}
				/>
			</div>

			{editedItem.vote ? (
				<div className="flex flex-col">
					<div className="flex w-min"></div>
					<LayerList store={derivedVoteChoiceStore} allowVotes={false} />
				</div>
			) : (
				<div className="flex space-x-2 min-h-0">
					<div>
						<LayerFilterMenu filterMenuStore={filterMenuStore} />
					</div>
					<ListStyleLayerPicker
						filter={filterMenuStore.filter}
						pickerMode="single"
						defaultSelected={[editedItem.layerId!]}
						select={(update) => {
							const id = (typeof update === 'function' ? update([]) : update)[0]
							return editedItemStore.getState().setItem((prev) => ({ ...prev, layerId: id }))
						}}
					/>
				</div>
			)}

			<DialogFooter>
				{editedItem.vote && (
					<SelectLayersPopover
						title="Add"
						description="Select layers to add to the voting pool"
						open={addLayersOpen}
						onOpenChange={setAddLayersOpen}
						selectQueueItems={(items) => {
							derivedVoteChoiceStore.getState().add(items)
						}}
					>
						<DropdownMenuItem>Add layers</DropdownMenuItem>
					</SelectLayersPopover>
				)}
				<Button disabled={!canSubmit} type="submit">
					Submit
				</Button>
			</DialogFooter>
		</form>
	)
}

function itemToMiniLayer(item: M.LayerListItem): M.MiniLayer {
	if (item.vote) {
		return M.getMiniLayerFromId(item.vote.defaultChoice)
	}
	if (item.layerId) {
		return M.getMiniLayerFromId(item.layerId)
	}
	throw new Error('Invalid LayerQueueItem')
}

const FILTER_ORDER = [
	'id',
	'Layer',
	'Level',
	'Gamemode',
	'LayerVersion',
	'Faction_1',
	'SubFac_1',
	'Faction_2',
	'SubFac_2',
] as const satisfies (keyof M.MiniLayer)[]

type FilterMenuStore = ReturnType<typeof useFilterMenuStore>
function useFilterMenuStore(baseFilter?: M.FilterNode) {
	// represents the state of the filter menu
	const [filterFields, setFilterFields] = React.useState<Partial<M.MiniLayer>>({})

	const filter = React.useMemo(() => {
		const nodes: M.FilterNode[] = []

		for (const _key in filterFields) {
			const key = _key as keyof M.MiniLayer
			if (filterFields[key] === undefined) continue
			nodes.push(FB.comp(FB.eq(key, filterFields[key])))
		}

		if (baseFilter) {
			nodes.push(baseFilter)
		}
		if (nodes.length === 0) return undefined
		return FB.and(nodes)
	}, [filterFields, baseFilter])

	// get a map of filters for all filterFields for which the predicates involving that field are removed
	const filtersExcludingField = React.useMemo(() => {
		//@ts-expect-error idc
		const filtersExcludingField: { [k in keyof M.MiniLayer]: M.FilterNode | undefined } = {}
		if (!filter) {
			return filtersExcludingField
		}
		for (const _key in filterFields) {
			const key = _key as keyof M.MiniLayer
			const fieldSelectFilter = Im.produce(filter, (draft) => {
				const idx = draft.children.findIndex((node) => node.type === 'comp' && node.comp.column === key)
				if (idx !== -1) {
					draft.children.splice(idx, 1)
				}
			})
			filtersExcludingField[key] = fieldSelectFilter
		}
		return filtersExcludingField
	}, [filterFields, filter])

	return {
		filter,
		filterFields,
		filtersExcludingField,
		setFilterFields,
	}
}

function LayerFilterMenu(props: { filterMenuStore: FilterMenuStore }) {
	const store = props.filterMenuStore
	// const applyBaseFilterId = React.useId()

	const filterComparisons: [keyof M.MiniLayer, M.EditableComparison][] = []
	for (const key of FILTER_ORDER) {
		filterComparisons.push([key, EFB.eq(key, store.filterFields[key])])
	}

	function applySetFilterFieldComparison(name: keyof M.MiniLayer): React.Dispatch<React.SetStateAction<M.EditableComparison>> {
		return (update) => {
			store.setFilterFields(
				// TODO having this be inline is kinda gross
				Im.produce((prev) => {
					const comp = typeof update === 'function' ? update(EFB.eq(name, prev[name])) : update
					if (comp.column === 'id' && comp.value) {
						return M.getMiniLayerFromId(comp.value as string)
					} else if (comp.column === 'Layer' && comp.value) {
						const parsedLayer = M.parseLayerString(comp.value as string)
						prev.Level = parsedLayer.level
						prev.Gamemode = parsedLayer.gamemode
						prev.LayerVersion = parsedLayer.version
					} else if (comp.column === 'Layer' && !comp.value) {
						delete prev.Layer
						delete prev.Level
						delete prev.Gamemode
						delete prev.LayerVersion
					} else if (comp !== undefined) {
						// @ts-expect-error null can be valid here
						prev[name] = comp.value
						// @ts-expect-error not sure
					} else if (comp.value === undefined) {
						delete prev[name]
					}
					if (M.LAYER_STRING_PROPERTIES.every((p) => p in prev)) {
						prev.Layer = M.getLayerString(prev as M.MiniLayer)
					} else {
						delete prev.Layer
					}
					delete prev.id

					// do we have all of the fields required to build the id? commented out for now because we don't want to auto populate the id field in most scenarios
					// if (Object.keys(comp).length >= Object.keys(M.MiniLayerSchema.shape).length - 1) {
					// 	prev.id = M.getLayerId(prev as M.LayerIdArgs)
					// }
				})
			)
		}
	}

	return (
		<div className="flex flex-col space-y-2">
			<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
				{filterComparisons.map(([name, comparison], index) => {
					const setComp = applySetFilterFieldComparison(name)
					function clear() {
						setComp(
							Im.produce((prev) => {
								delete prev.value
							})
						)
					}

					function swapFactions() {
						store.setFilterFields(
							Im.produce((prev) => {
								const faction1 = prev.Faction_1
								const subFac1 = prev.SubFac_1
								prev.Faction_1 = prev.Faction_2
								prev.SubFac_1 = prev.SubFac_2
								prev.Faction_2 = faction1
								prev.SubFac_2 = subFac1
							})
						)
					}

					return (
						<React.Fragment key={name}>
							{(name === 'Level' || name === 'Faction_1') && <Separator className="col-span-4 my-2" />}
							{name === 'Faction_2' && (
								<>
									<Button
										disabled={
											!(store.filterFields.Faction_1 || store.filterFields.SubFac_1) &&
											!(store.filterFields.Faction_2 || store.filterFields.SubFac_2)
										}
										onClick={swapFactions}
										variant="secondary"
									>
										Swap Factions
									</Button>
									<span />
									<span />
									<span />
								</>
							)}
							<Comparison
								columnEditable={false}
								comp={comparison}
								setComp={setComp}
								valueAutocompleteFilter={store.filtersExcludingField[name]}
							/>
							<Button disabled={comparison.value === undefined} variant="ghost" size="icon" onClick={clear}>
								<Icons.Trash />{' '}
							</Button>
						</React.Fragment>
					)
				})}
			</div>
			<Button variant="secondary" onClick={() => store.setFilterFields({})}>
				Clear All
			</Button>
		</div>
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

type IdedLLItem = M.LayerListItem & WithMutationId
