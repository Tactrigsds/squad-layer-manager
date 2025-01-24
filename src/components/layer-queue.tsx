import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useShallow } from 'zustand/react/shallow'
import { useForm } from '@tanstack/react-form'
import { CSS } from '@dnd-kit/utilities'
import * as Im from 'immer'
import { Edit, EllipsisVertical, GripVertical, LoaderCircle, PlusIcon } from 'lucide-react'
import deepEqual from 'fast-deep-equal'
import React from 'react'
import * as AR from '@/app-routes.ts'
import * as FB from '@/lib/filter-builders.ts'

import * as RbacClient from '@/systems.client/rbac.client.ts'
import * as RBAC from '@/rbac.models'
import * as Icons from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import * as DH from '@/lib/display-helpers'
import * as EFB from '@/lib/editable-filter-builders'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'

import { Comparison } from './filter-card'
import TabsList from './ui/tabs-list.tsx'
import { assertNever } from '@/lib/typeGuards.ts'
import { Checkbox } from './ui/checkbox.tsx'
import { initMutationState } from '@/lib/item-mutations.ts'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'
import { useLoggedInUser } from '@/systems.client/logged-in-user'

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
import { useFilter, useFilters } from '@/hooks/filters.ts'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'

import { getDisplayedMutation, hasMutations } from '@/lib/item-mutations.ts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { deepClone } from '@/lib/object.ts'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'
import { useConfig } from '@/systems.client/config.client.ts'
import { useAbortVote, useStartVote, useVoteState } from '@/hooks/votes.ts'
import { useDragEnd } from '@/systems.client/dndkit.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import * as PartsSys from '@/systems.client/parts.ts'
import LayerTable from './layer-table.tsx'
import { zodValidator } from '@tanstack/zod-form-adapter'
import { useAreLayersInPool } from '@/hooks/use-layer-queries.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import { useUserPresenceState } from '@/systems.client/presence.ts'

export default function ServerDashboard() {
	const serverStatus = useSquadServerStatus()
	const settingsPanelRef = React.useRef<ServerSettingsPanelHandle>(null)

	const toaster = useToast()
	const updateQueueMutation = useMutation({
		mutationFn: trpc.layerQueue.updateQueue.mutate,
	})
	// const validatedHistoryFilters = M.histo
	async function saveLqState() {
		const serverStateMut = QD.QDStore.getState().editedServerState
		const res = await updateQueueMutation.mutateAsync(serverStateMut)
		const reset = QD.QDStore.getState().reset
		switch (res.code) {
			case 'err:permission-denied':
				RbacClient.showPermissionDenied(res)
				reset()
				break
			case 'err:out-of-sync':
				toaster.toast({
					title: 'State changed before submission, please try again.',
					variant: 'destructive',
				})
				reset()
				return
			case 'err:queue-change-during-vote':
				toaster.toast({
					title: 'Cannot update: layer vote in progress',
					variant: 'destructive',
				})
				reset()
				break
			case 'ok':
				toaster.toast({ title: 'Changes applied' })
				break
			default:
				assertNever(res)
		}
	}

	const [playNextPopoverOpen, setPlayNextPopoverOpen] = React.useState(false)
	const [appendLayersPopoverOpen, setAppendLayersPopoverOpen] = React.useState(false)

	const { isEditing, canEdit } = Zus.useStore(
		QD.QDStore,
		useShallow((s) => {
			return { isEditing: s.isEditing, canEdit: s.canEditQueue }
		})
	)
	const userPresenceState = useUserPresenceState()
	const editingUser = userPresenceState?.editState && PartsSys.findUser(userPresenceState.editState.userId)
	const loggedInUser = useLoggedInUser()

	const queueHasMutations = Zus.useStore(QD.LQStore, (s) => hasMutations(s.listMutations))

	return (
		<div className="contianer mx-auto grid place-items-center py-10">
			<span className="flex space-x-4">
				<VoteState />
				<div className="flex flex-col space-y-4">
					{/* ------- top card ------- */}
					<Card>
						{!isEditing && serverStatus?.currentLayer && !editingUser && (
							<>
								<CardHeader>
									<CardTitle>Now Playing</CardTitle>
								</CardHeader>
								<CardContent>{DH.displayPossibleUnknownLayer(serverStatus.currentLayer)}</CardContent>
							</>
						)}
						{!isEditing && editingUser && (
							<Alert variant="info">
								<AlertTitle>
									{editingUser.discordId === loggedInUser?.discordId
										? 'You are editing on another tab'
										: editingUser.username + ' is editing'}
								</AlertTitle>
							</Alert>
						)}
						{!isEditing && !serverStatus?.currentLayer && <p className={Typography.P}>No active layer found</p>}
						{isEditing && (
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
										<Button onClick={() => QD.QDStore.getState().reset()} variant="secondary">
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
								<SelectLayersDialog
									title="Add to Queue"
									description="Select layers to add to the queue"
									selectQueueItems={(items) => QD.LQStore.getState().add(items)}
									open={appendLayersPopoverOpen}
									onOpenChange={setAppendLayersPopoverOpen}
								>
									<Button
										data-canedit={canEdit}
										className="flex w-min items-center space-x-1 data-[canedit=false]:invisible"
										variant="default"
									>
										<PlusIcon />
										<span>Play After</span>
									</Button>
								</SelectLayersDialog>
								<SelectLayersDialog
									title="Play Next"
									description="Select layers to play next"
									selectQueueItems={(items) => QD.LQStore.getState().add(items, 0)}
									open={playNextPopoverOpen}
									onOpenChange={setPlayNextPopoverOpen}
								>
									<Button
										data-canedit={canEdit}
										className="flex w-min items-center space-x-1 data-[canedit=false]:invisible"
										variant="default"
									>
										<PlusIcon />
										<span>Play Next</span>
									</Button>
								</SelectLayersDialog>
							</div>
						</CardHeader>
						<CardContent>
							<LayerList store={QD.LQStore} allowVotes={true} />
						</CardContent>
					</Card>
				</div>
				<div>
					<ServerSettingsPanel ref={settingsPanelRef} />
				</div>
			</span>
		</div>
	)
}

function EditSummary() {
	const queueMutations = Zus.useStore(QD.LQStore, (s) => s.listMutations)
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
export function LayerList(props: { store: Zus.StoreApi<QD.LLStore>; allowVotes?: boolean }) {
	const user = useLoggedInUser()
	const allowVotes = props.allowVotes ?? true
	const queueIds = Zus.useStore(props.store).layerList.map((item) => item.id)
	useDragEnd((event) => {
		if (!event.over) return
		const { layerList: layerQueue, move } = props.store.getState()
		const sourceIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.active.id as string))
		const targetIndex = getIndexFromQueueItemId(layerQueue, JSON.parse(event.over.id as string))
		if (!user) return
		move(sourceIndex, targetIndex, user.discordId)
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
	const squadServerStatus = useSquadServerStatus()
	const loggedInUser = useLoggedInUser()

	async function abortVote() {
		const serverStateMut = QD.QDStore.getState().editedServerState
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
	const startVoteForm = useForm({
		defaultValues: {
			durationSeconds: slmConfig?.defaults.voteDurationSeconds ?? 30,
			minValidVotePercentage: slmConfig?.defaults.minValidVotePercentage ?? 75,
		},
		validatorAdapter: zodValidator(),
		onSubmit: async ({ value }) => {
			const res = await startVoteMutation.mutateAsync({
				durationSeconds: value.durationSeconds,
				minValidVotePercentage: value.minValidVotePercentage,
			})
			switch (res.code) {
				case 'ok':
					toaster.toast({ title: 'Vote started!' })
					break
				case 'err:permission-denied':
					RbacClient.showPermissionDenied(res)
					break
				case 'err:no-vote-exists':
				case 'err:vote-in-progress':
					toaster.toast({
						title: 'Failed to start vote',
						description: res.code,
						variant: 'destructive',
					})
					break
				default:
					assertNever(res)
			}
		},
	})

	const voteDurationEltId = React.useId()
	const minRequiredEltId = React.useId()
	const canManageVote = loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, { check: 'all', permits: [RBAC.perm('vote:manage')] })

	if (!voteState || !squadServerStatus) return null
	function onSubmit(e: React.FormEvent) {
		e.preventDefault()
		e.stopPropagation()
		startVoteForm.handleSubmit()
	}

	const voteConfigElt = (
		<form onSubmit={onSubmit} className="flex flex-col space-y-2">
			<startVoteForm.Field
				name="durationSeconds"
				validators={{ onChange: M.StartVoteInputSchema.shape.durationSeconds }}
				children={(field) => (
					<>
						<Label htmlFor={voteDurationEltId}>Vote Duration (seconds)</Label>
						<Input
							id={voteDurationEltId}
							name={field.name}
							type="number"
							disabled={!canManageVote}
							defaultValue={field.state.value}
							onChange={(e) => {
								return field.setValue(e.target.valueAsNumber)
							}}
						/>
						{field.state.meta.errors.length > 0 && <Alert variant="destructive">{field.state.meta.errors.join(', ')}</Alert>}
					</>
				)}
			/>
			<startVoteForm.Field
				name="minValidVotePercentage"
				validators={{ onChange: M.StartVoteInputSchema.shape.minValidVotePercentage, onChangeAsyncDebounceMs: 250 }}
				children={(field) => (
					<>
						<Label htmlFor={minRequiredEltId}>Min Required Turnout(%)</Label>
						<Input
							id={minRequiredEltId}
							type="number"
							disabled={!canManageVote}
							defaultValue={field.state.value}
							onChange={(e) => {
								return field.setValue(e.target.valueAsNumber)
							}}
						/>
						{field.state.meta.errors.length > 0 && <Alert variant="destructive">{field.state.meta.errors.join(', ')}</Alert>}
					</>
				)}
			/>
		</form>
	)

	const rerunVoteBtn = (
		<Button
			onClick={async () => {
				const id = await openDialog({
					title: 'Rerun Vote',
					description: 'Are you sure you want to rerun the vote?',
					buttons: [{ label: 'Rerun Vote', id: 'confirm' }],
				})
				if (id === 'confirm') startVoteForm.handleSubmit()
			}}
			variant="secondary"
		>
			Rerun Vote
		</Button>
	)
	const cancelBtn = (
		<Button
			disabled={!canManageVote}
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
						disabled={!canManageVote}
						onClick={async () => {
							const id = await openDialog({
								title: 'Start Vote',
								description: 'Are you sure you want to start the vote?',
								buttons: [{ label: 'Start Vote', id: 'confirm' }],
							})
							if (id === 'confirm') startVoteForm.handleSubmit()
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
						<VoteTallyDisplay voteState={voteState} playerCount={squadServerStatus.playerCount} />
						{cancelBtn}
					</>
				)
			}
			break
		case 'ended:winner':
			body = (
				<>
					<VoteTallyDisplay voteState={voteState} playerCount={squadServerStatus.playerCount} />
					{rerunVoteBtn}
					{voteConfigElt}
				</>
			)
			break
		case 'ended:insufficient-votes':
		case 'ended:aborted': {
			const user = voteState.code === 'ended:aborted' ? voteState.aborter.discordId && PartsSys.findUser(voteState.aborter.discordId) : null
			body = (
				<>
					<VoteTallyDisplay voteState={voteState} playerCount={squadServerStatus.playerCount} />
					<Alert variant="destructive">
						<AlertTitle>Vote Aborted</AlertTitle>
						{voteState.code === 'ended:insufficient-votes' && <AlertDescription>Insufficient votes to determine a winner</AlertDescription>}
						{voteState.code === 'ended:aborted' &&
							(user ? (
								<AlertDescription>Vote was manually aborted by {user.username}</AlertDescription>
							) : (
								<AlertDescription>Vote was Aborted</AlertDescription>
							))}
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
		<div>
			<Card>
				<CardHeader>
					<CardTitle>Vote</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col space-y-2">{body}</CardContent>
			</Card>
		</div>
	)
}

function FilterEntitySelect(props: {
	className?: string
	title: string
	filterId: string | null
	onSelect: (filterId: string | null) => void
	allowToggle?: boolean
	enabled?: boolean
	setEnabled?: (enabled: boolean) => void
}) {
	const filtersRes = useFilters()
	const filterOptions = filtersRes.data?.map?.((f) => ({
		value: f.id,
		label: f.name,
	}))
	const enableCheckboxId = React.useId()
	return (
		<div className={cn('flex space-x-2 items-center', props.className)}>
			{props.allowToggle && (
				<>
					<Checkbox
						id={enableCheckboxId}
						onCheckedChange={(v) => {
							if (v === 'indeterminate') return
							props.setEnabled?.(v)
						}}
						checked={props.enabled}
					/>
					<ComboBox
						title="Filter"
						disabled={props.allowToggle && !props.enabled}
						className="flex-grow"
						options={filterOptions ?? LOADING}
						allowEmpty={true}
						value={props.filterId}
						onSelect={(filter) => props.onSelect(filter ?? null)}
					/>
				</>
			)}
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
	const eltRef = React.useRef<HTMLDivElement>(null)

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
	const canEditSettings = Zus.useStore(QD.QDStore, (s) => s.canEditSettings)

	const changedSettings = Zus.useStore(QD.QDStore, (s) => {
		if (!s.serverState) return null
		return M.getSettingsChanged(s.serverState.settings, s.editedServerState.settings)
	})
	const settings = Zus.useStore(QD.QDStore, (s) => s.editedServerState.settings)
	const setSetting = Zus.useStore(QD.QDStore, (s) => s.setSetting)
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
							disabled={!canEditSettings}
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
	const numVoteChoicesId = React.useId()
	const canEditSettings = Zus.useStore(QD.QDStore, (s) => s.canEditSettings)

	const genereateMutation = useMutation({
		mutationFn: generateLayerQueueItems,
	})
	if (!canEditSettings) return null
	async function generateLayerQueueItems() {
		let serverStateMut = QD.QDStore.getState().editedServerState
		const numVoteChoices = serverStateMut.settings.queue.preferredNumVoteChoices
		const seqIdBefore = serverStateMut.layerQueueSeqId
		const before = deepClone(serverStateMut.layerQueue)
		const generated = await trpc.layerQueue.generateLayerQueueItems.query({
			numToAdd: numItemsToGenerate,
			numVoteChoices,
			itemType,
			baseFilterId: serverStateMut?.settings.queue.poolFilterId,
		})

		const seqIdAfter = QD.QDStore.getState().editedServerState.layerQueueSeqId
		if (seqIdBefore !== seqIdAfter || !deepEqual(before, serverStateMut.layerQueue)) return

		// this technically should be unnecessary, but just in case
		serverStateMut = QD.QDStore.getState().editedServerState

		if (replaceCurrentGenerated) {
			// Remove generated items from end of queue
			while (
				serverStateMut.layerQueue.length > 0 &&
				serverStateMut.layerQueue[serverStateMut.layerQueue.length - 1].source === 'generated'
			) {
				QD.LQStore.getState().remove(serverStateMut.layerQueue[serverStateMut.layerQueue.length - 1].id)
			}
		}

		QD.LQStore.getState().add(generated)
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

export type QueueItemAction =
	| {
			code: 'move'
			sourceId: string
			destinationId: string
	  }
	| {
			code: 'edit'
			item: QD.IdedLLItem
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

function getIndexFromQueueItemId(items: QD.IdedLLItem[], id: string | null) {
	if (id === null) return -1
	return items.findIndex((item) => item.id === id)
}

type QueueItemProps = {
	index: number
	isLast: boolean
	allowVotes?: boolean
	id: string
	llStore: Zus.StoreApi<QD.LLStore>
}

function LayerListItem(props: QueueItemProps) {
	const itemStore = React.useMemo(() => QD.deriveLLItemStore(props.llStore, props.id), [props.llStore, props.id])
	const allowVotes = props.allowVotes ?? true
	const item = Zus.useStore(itemStore, (s) => s.item)
	const canEdit = Zus.useStore(QD.QDStore, (s) => s.canEditQueue)
	const draggableItemId = QD.toDraggableItemId(item.id)
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: draggableItemId,
	})

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = (update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}

	const style = { transform: CSS.Translate.toString(transform) }
	const itemDropdown = (
		<ItemDropdown
			allowVotes={allowVotes}
			index={props.index}
			open={dropdownOpen && canEdit}
			setOpen={setDropdownOpen}
			listStore={props.llStore}
			itemStore={itemStore}
		>
			<Button
				disabled={!canEdit}
				data-canedit={canEdit}
				className="invisible data-[canedit=true]:group-hover:visible"
				variant="ghost"
				size="icon"
			>
				<EllipsisVertical />
			</Button>
		</ItemDropdown>
	)
	let sourceBadge: React.ReactNode
	const modifiedBy = item.lastModifiedBy && PartsSys.findUser(item.lastModifiedBy)
	const modifiedByDisplay = modifiedBy ? `- ${modifiedBy.username}` : ''

	switch (item.source) {
		case 'gameserver':
			sourceBadge = <Badge variant="outline">Game Server</Badge>
			break
		case 'generated':
			sourceBadge = <Badge variant="outline">Generated {modifiedByDisplay}</Badge>
			break
		case 'manual': {
			sourceBadge = <Badge variant="outline">Manual {modifiedByDisplay}</Badge>
			break
		}
		default:
			assertNever(item.source)
	}

	const queueItemStyles = `bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30 cursor-default`
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
	const gripElt = (
		<Button
			{...listeners}
			disabled={!canEdit}
			variant="ghost"
			size="icon"
			data-canedit={canEdit}
			className="invisible data-[canedit=true]:cursor-grab data-[canedit=true]:group-hover:visible"
		>
			<GripVertical />
		</Button>
	)

	if (item.vote) {
		return (
			<>
				{props.index === 0 && <QueueItemSeparator itemId={QD.toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn('group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1', queueItemStyles)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					<div className="flex items-center">{gripElt}</div>
					<div className="h-full flex flex-col flex-grow">
						<label className={Typography.Muted}>Vote</label>
						<ol className={'flex flex-col space-y-1 items-start'}>
							{item.vote.choices.map((choice, index) => {
								const chosenBadge = choice === item.layerId ? <Badge variant="added">chosen</Badge> : null
								return (
									<li key={choice} className="flex items-center ">
										<span className="mr-2">{index + 1}.</span>
										<LayerDisplay layerId={choice} badges={chosenBadge} />
									</li>
								)
							})}
						</ol>
						<div>{sourceBadge}</div>
						{notCurrentNextLayer}
					</div>
					{itemDropdown}
				</li>
				<QueueItemSeparator itemId={draggableItemId} isLast={props.isLast} />
			</>
		)
	}

	if (item.layerId) {
		return (
			<>
				{props.index === 0 && <QueueItemSeparator itemId={QD.toDraggableItemId(null)} isLast={false} />}
				<li
					ref={setNodeRef}
					style={style}
					{...attributes}
					className={cn(`group flex w-full items-center justify-between space-x-2 px-1 pb-2 pt-1 min-w-0`, queueItemStyles)}
					data-mutation={displayedMutation}
					data-is-dragging={isDragging}
				>
					{gripElt}
					<div className="flex flex-col w-max flex-grow">
						<div className="flex items-center flex-shrink-0">
							<LayerDisplay layerId={item.layerId} />
						</div>
						<span>{sourceBadge}</span>
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
	itemStore: Zus.StoreApi<QD.LLItemStore>
	listStore: Zus.StoreApi<QD.LLStore>
	allowVotes?: boolean
}) {
	const allowVotes = props.allowVotes ?? true

	type SubDropdownState = 'add-before' | 'add-after' | 'edit' | null
	const [subDropdownState, _setSubDropdownState] = React.useState(null as SubDropdownState)

	function setSubDropdownState(state: SubDropdownState) {
		if (state === null) props.setOpen(false)
		_setSubDropdownState(state)
	}

	const baseFilter = QD.selectFilterExcludingLayersFromList(Zus.useStore(props.listStore))
	const user = useLoggedInUser()
	return (
		<DropdownMenu open={props.open || !!subDropdownState} onOpenChange={props.setOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuGroup>
					<EditLayerListItemDialogWrapper
						allowVotes={allowVotes}
						open={subDropdownState === 'edit'}
						onOpenChange={(update) => {
							const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
							return setSubDropdownState(open ? 'edit' : null)
						}}
						itemStore={props.itemStore}
						baseFilter={baseFilter}
					>
						<DropdownMenuItem>Edit</DropdownMenuItem>
					</EditLayerListItemDialogWrapper>
					<DropdownMenuItem
						onClick={() => {
							const id = props.itemStore.getState().item.id
							props.listStore.getState().remove(id)
						}}
						className="bg-destructive text-destructive-foreground focus:bg-red-600"
					>
						Delete
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />

				<DropdownMenuGroup>
					<SelectLayersDialog
						title="Add layers before"
						description="Select layers to add before"
						open={subDropdownState === 'add-before'}
						onOpenChange={(open) => setSubDropdownState(open ? 'add-before' : null)}
						selectingSingleLayerQueueItem={true}
						selectQueueItems={(items) => {
							const state = props.listStore.getState()
							state.add(items, props.index)
						}}
						baseFilter={baseFilter}
					>
						<DropdownMenuItem>Add layers before</DropdownMenuItem>
					</SelectLayersDialog>

					<SelectLayersDialog
						title="Add layers after"
						description="Select layers to add after"
						open={subDropdownState === 'add-after'}
						onOpenChange={(open) => setSubDropdownState(open ? 'add-after' : null)}
						selectQueueItems={(items) => {
							const state = props.listStore.getState()
							state.add(items, props.index + 1)
						}}
						baseFilter={baseFilter}
					>
						<DropdownMenuItem>Add layers after</DropdownMenuItem>
					</SelectLayersDialog>
				</DropdownMenuGroup>

				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={() => {
							if (!user) return
							const item = props.itemStore.getState().item
							const itemIdx = props.listStore.getState().layerList.findIndex((i) => i.id === item.id)
							props.listStore.getState().move(itemIdx, -1, user.discordId)
						}}
					>
						Send to Front
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							if (!user) return
							const layerList = props.listStore.getState().layerList
							const item = props.itemStore.getState().item
							const itemIdx = layerList.findIndex((i) => i.id === item.id)
							const lastIdx = layerList.length - 1
							props.listStore.getState().move(itemIdx, lastIdx, user.discordId)
						}}
					>
						Send to Back
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function LayerDisplay(props: { layerId: M.LayerId; badges?: React.ReactNode }) {
	const poolFilterId = Zus.useStore(QD.QDStore, QD.selectCurrentPoolFilterId)
	const isLayerInPoolRes = useAreLayersInPool({ layers: [props.layerId], poolFilterId: poolFilterId })
	const filterRes = useFilter(poolFilterId)
	let notInPoolBadge: React.ReactNode = null
	if (isLayerInPoolRes.data && isLayerInPoolRes.data.code === 'ok' && !isLayerInPoolRes.data.results[0].matchesFilter) {
		notInPoolBadge = (
			<Tooltip>
				<TooltipTrigger>
					<Icons.ShieldQuestion className="text-orange-400" />
				</TooltipTrigger>
				<TooltipContent>
					Layer not in configured pool <b>{filterRes.data?.name}</b>
				</TooltipContent>
			</Tooltip>
		)
	}

	return (
		<div className="flex space-x-2 items-center">
			<span className="flex-1 text-nowrap">{DH.toShortLayerNameFromId(props.layerId)}</span>
			<span className="flex items-center space-x-1">
				{notInPoolBadge}
				{props.badges}
			</span>
		</div>
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
			className="w-full min-w-0 bg-transparent data-[is-last=true]:invisible data-[is-over=true]:bg-secondary-foreground"
			data-is-last={props.isLast && !isOver}
			data-is-over={isOver}
		/>
	)
}

type SelectMode = 'vote' | 'layers'

export function SelectLayersDialog(props: {
	title: string
	description: React.ReactNode
	pinMode?: SelectMode
	children: React.ReactNode
	selectQueueItems: (queueItems: M.LayerListItem[]) => void
	defaultSelected?: M.LayerId[]
	selectingSingleLayerQueueItem?: boolean
	baseFilter?: M.FilterNode
	open: boolean
	onOpenChange: (isOpen: boolean) => void
}) {
	const defaultSelected: M.LayerId[] = props.defaultSelected ?? []

	const poolFilterId = Zus.useStore(QD.QDStore, QD.selectCurrentPoolFilterId)
	const [selectedFilterId, setSelectedFilterId] = React.useState<M.FilterEntityId | null>(poolFilterId ?? null)
	React.useLayoutEffect(() => {
		if (poolFilterId) setSelectedFilterId(poolFilterId)
	}, [poolFilterId])
	const filterEntity = useFilter(selectedFilterId ?? undefined).data
	const [selectedFilterEnabled, setSelectedFilterEnabled] = React.useState(true)
	let baseFilter: M.FilterNode | undefined
	if (props.baseFilter && filterEntity?.filter && selectedFilterEnabled) {
		baseFilter = FB.and([props.baseFilter, filterEntity.filter])
	} else if (filterEntity?.filter && selectedFilterEnabled) {
		baseFilter = filterEntity.filter
	} else if (props.baseFilter) {
		baseFilter = props.baseFilter
	}
	const filterMenuStore = useFilterMenuStore(baseFilter)

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
	const user = useLoggedInUser()

	const canSubmit = selectedLayers.length > 0
	function submit() {
		if (!canSubmit) return
		if (selectMode === 'layers') {
			const items: M.LayerListItem[] = selectedLayers.map(
				(layerId) =>
					({
						layerId: layerId,
						source: 'manual',
						lastModifiedBy: user!.discordId,
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
				lastModifiedBy: user!.discordId,
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
				<div className="w-min">
					<FilterEntitySelect
						title="Filter"
						filterId={selectedFilterId}
						className="max-w-16"
						onSelect={setSelectedFilterId}
						allowToggle={true}
						enabled={selectedFilterEnabled}
						setEnabled={setSelectedFilterEnabled}
					/>
				</div>

				<div className="flex min-h-0 items-center space-x-2">
					<LayerFilterMenu filterMenuStore={filterMenuStore} />
					<TableStyleLayerPicker filter={filterMenuStore.filter} selected={selectedLayers} onSelect={setSelectedLayers} />
				</div>

				<DialogFooter>
					<Button disabled={!canSubmit} onClick={submit}>
						Submit
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function TableStyleLayerPicker(props: {
	filter?: M.FilterNode
	selected: M.LayerId[]
	onSelect: React.Dispatch<React.SetStateAction<M.LayerId[]>>
	maxSelected?: number
}) {
	const [pageIndex, setPageIndex] = React.useState(0)

	const defaultColumns: (M.LayerColumnKey | M.LayerCompositeKey)[] = [
		'Layer',
		'Faction_1',
		'SubFac_1',
		'Faction_2',
		'SubFac_2',
		'Asymmetry_Score',
		'Balance_Differential',
	]

	return (
		<div className="flex h-full">
			<LayerTable
				filter={props.filter}
				defaultColumns={defaultColumns}
				pageIndex={pageIndex}
				autoSelectIfSingleResult={props.maxSelected === 1}
				setPageIndex={setPageIndex}
				selected={props.selected}
				setSelected={props.onSelect}
				maxSelected={props.maxSelected}
				defaultSortBy="random"
				defaultSortDirection="DESC"
				canChangeRowsPerPage={false}
				canToggleColumns={false}
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
} & InnerEditLayerListItemDialogProps

type InnerEditLayerListItemDialogProps = {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	allowVotes?: boolean
	itemStore: Zus.StoreApi<QD.LLItemStore>
	baseFilter?: M.FilterNode
}

function EditLayerListItemDialogWrapper(props: EditLayerQueueItemDialogProps) {
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

export function EditLayerListItemDialog(props: InnerEditLayerListItemDialogProps) {
	const allowVotes = props.allowVotes ?? true

	const initialItem = Zus.useStore(props.itemStore, (s) => s.item)

	const editedItemStore = React.useMemo(() => {
		return Zus.create<QD.LLItemStore>((set, get) =>
			QD.createLLItemStore(set, get, { item: initialItem, mutationState: initMutationState() })
		)
	}, [initialItem])
	const editedItem = Zus.useStore(editedItemStore, (s) => s.item)

	const derivedVoteChoiceStore = React.useMemo(() => QD.deriveVoteChoiceListStore(editedItemStore), [editedItemStore])

	const loggedInUser = useLoggedInUser()

	const excludeVoteDuplicatesFilter = QD.selectFilterExcludingLayersFromList(Zus.useStore(derivedVoteChoiceStore))
	const [addLayersOpen, setAddLayersOpen] = React.useState(false)

	const filtersRes = useFilters()

	const poolFilterId = Zus.useStore(QD.QDStore, QD.selectCurrentPoolFilterId)
	const [selectedFilterId, setSelectedBaseFilterId] = React.useState<M.FilterEntityId | null>(poolFilterId ?? null)
	const [filterEnabled, setFilterEnabled] = React.useState(true)

	const selectedFilterEntity = filtersRes.data?.find((f) => f.id === selectedFilterId)
	let baseFilter: M.FilterNode | undefined
	if (selectedFilterEntity?.filter && filterEnabled && props.baseFilter) {
		baseFilter = FB.and([props.baseFilter, selectedFilterEntity.filter])
	} else if (selectedFilterEntity?.filter && filterEnabled) {
		baseFilter = selectedFilterEntity.filter
	} else if (props.baseFilter) {
		baseFilter = props.baseFilter
	}

	const filterMenuStore = useFilterMenuStore(
		baseFilter,
		editedItem.layerId && filterEnabled ? M.getMiniLayerFromId(editedItem.layerId) : undefined
	)

	const canSubmit = Zus.useStore(
		editedItemStore,
		(s) => !deepEqual(initialItem, s.item) && (!s.item.vote || s.item.vote.choices.length > 0)
	)
	function submit() {
		if (!canSubmit) return
		props.onOpenChange(false)
		props.itemStore.getState().setItem(editedItem)
	}

	if (!props.allowVotes && editedItem.vote) throw new Error('Invalid queue item')

	return (
		<div className="w-full h-full">
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
										lastModifiedBy: loggedInUser!.discordId,
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
					filterId={selectedFilterId}
					onSelect={(id) => setSelectedBaseFilterId(id)}
					allowToggle={true}
					enabled={filterEnabled}
					setEnabled={setFilterEnabled}
				/>
			</div>

			{editedItem.vote ? (
				<div className="flex flex-col">
					<div className="flex w-min"></div>
					<LayerList store={derivedVoteChoiceStore} allowVotes={false} />
				</div>
			) : (
				<div className="flex space-x-2 min-h-0">
					<LayerFilterMenu filterMenuStore={filterMenuStore} />
					<TableStyleLayerPicker
						filter={filterMenuStore.filter}
						maxSelected={1}
						selected={[editedItem.layerId!]}
						onSelect={(update) => {
							const id = (typeof update === 'function' ? update([]) : update)[0]
							if (!id) return
							return editedItemStore.getState().setItem((prev) => ({ ...prev, layerId: id }))
						}}
					/>
				</div>
			)}

			<DialogFooter>
				{editedItem.vote && (
					<SelectLayersDialog
						title="Add"
						description="Select layers to add to the voting pool"
						open={addLayersOpen}
						onOpenChange={setAddLayersOpen}
						baseFilter={excludeVoteDuplicatesFilter}
						selectQueueItems={(items) => {
							derivedVoteChoiceStore.getState().add(items)
						}}
					>
						<DropdownMenuItem>Add layers</DropdownMenuItem>
					</SelectLayersDialog>
				)}
				<Button disabled={!canSubmit} onClick={submit}>
					Submit
				</Button>
			</DialogFooter>
		</div>
	)
}

type FilterMenuStore = ReturnType<typeof useFilterMenuStore>

function getDefaultFilterMenuItemState(defaultFields: Partial<M.MiniLayer>): M.EditableComparison[] {
	return [
		EFB.eq('id', defaultFields['id']),
		EFB.eq('Layer', defaultFields['Layer']),
		EFB.eq('Level', defaultFields['Level']),
		EFB.eq('Gamemode', defaultFields['Gamemode']),
		EFB.eq('LayerVersion', defaultFields['LayerVersion']),
		EFB.eq('Faction_1', defaultFields['Faction_1']),
		EFB.eq('SubFac_1', defaultFields['SubFac_1']),
		EFB.eq('Faction_2', defaultFields['Faction_2']),
		EFB.eq('SubFac_2', defaultFields['SubFac_2']),
	]
}

function useFilterMenuStore(baseFilter?: M.FilterNode, defaultFields: Partial<M.MiniLayer> = {}) {
	const [items, setItems] = React.useState(getDefaultFilterMenuItemState(defaultFields))

	const filter = React.useMemo(() => {
		const nodes: M.FilterNode[] = []
		for (const item of items) {
			if (!M.isValidComparison(item)) continue
			nodes.push(FB.comp(item))
		}

		if (baseFilter) {
			nodes.push(baseFilter)
		}
		if (nodes.length === 0) return undefined
		return FB.and(nodes)
	}, [items, baseFilter])

	// get a map of filters for all filterFields for which the predicates involving that field are removed
	const filtersExcludingField = React.useMemo(() => {
		//@ts-expect-error idc
		const filtersExcludingField: { [k in keyof M.MiniLayer]: M.FilterNode | undefined } = {}
		if (!filter) {
			return filtersExcludingField
		}
		for (const item of items) {
			const key = item.column as keyof M.MiniLayer
			const colsToRemove: string[] = []
			colsToRemove.push(key)
			colsToRemove.push('id')
			if (key === 'id') {
				filtersExcludingField[key] = baseFilter
				continue
			}
			if (key === 'Layer') {
				colsToRemove.push('Level')
				colsToRemove.push('Gamemode')
				colsToRemove.push('LayerVersion')
			}
			if (['Level', 'Gamemode', 'LayerVersion'].includes(key)) {
				colsToRemove.push('Layer')
			}
			const fieldSelectFilter = Im.produce(filter, (draft) => {
				for (const col of colsToRemove) {
					const index = draft.children.findIndex((node) => node.type === 'comp' && node.comp.column === col)
					if (index !== -1) draft.children.splice(index, 1)
				}
			})
			filtersExcludingField[key] = fieldSelectFilter
		}
		return filtersExcludingField
	}, [items, filter, baseFilter])

	return {
		filter,
		menuItems: items,
		filtersExcludingField,
		setMenuItems: setItems,
	}
}

function LayerFilterMenu(props: { filterMenuStore: FilterMenuStore }) {
	const store = props.filterMenuStore
	// const applyBaseFilterId = React.useId()

	function applySetFilterFieldComparison(name: keyof M.MiniLayer): React.Dispatch<React.SetStateAction<M.EditableComparison>> {
		return (update) => {
			store.setMenuItems(
				// TODO having this be inline is kinda gross
				Im.produce((draft) => {
					const prevComp = draft.find((item) => item.column === name)!
					const comp = typeof update === 'function' ? update(prevComp) : update
					const idxMap: Record<string, number> = {}
					draft.forEach((item, idx) => {
						idxMap[item.column!] = idx
					})

					if (comp.column === 'id' && comp.value) {
						return getDefaultFilterMenuItemState(M.getMiniLayerFromId(comp.value as string))
					} else if (comp.column === 'Layer' && comp.value) {
						const parsedLayer = M.parseLayerString(comp.value as string)
						draft[idxMap['Level']].value = parsedLayer.level
						draft[idxMap['Gamemode']].value = parsedLayer.gamemode
						draft[idxMap['LayerVersion']].value = parsedLayer.version
					} else if (comp.column === 'Layer' && !comp.value) {
						delete draft[idxMap['Layer']].value
						delete draft[idxMap['Level']].value
						delete draft[idxMap['Gamemode']].value
						delete draft[idxMap['LayerVersion']].value
					} else if (comp !== undefined) {
						const idx = draft.findIndex((item) => item.column === name)
						draft[idx] = comp
					}
					const cols = draft.map((item) => item.column)
					if (M.LAYER_STRING_PROPERTIES.every((p) => p in cols)) {
						draft[idxMap['Layer']].value = M.getLayerString({
							Gamemode: draft[idxMap['Gamemode']].value!,
							Level: draft[idxMap['Level']].value!,
							LayerVersion: draft[idxMap['LayerVersion']].value!,
						} as Parameters<typeof M.getLayerString>[0])
					} else {
						delete draft[idxMap['Layer']].value
					}
					delete draft[idxMap['id']].value

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
				{store.menuItems.map((comparison) => {
					const name = comparison.column as keyof M.MiniLayer
					const setComp = applySetFilterFieldComparison(name)
					function clear() {
						setComp(
							Im.produce((prev) => {
								delete prev.value
							})
						)
					}

					function swapFactions() {
						store.setMenuItems(
							Im.produce((draft) => {
								const idxMap: Record<string, number> = {}
								draft.forEach((item, idx) => {
									idxMap[item.column!] = idx
								})
								const faction1 = draft[idxMap['Faction_1']].value
								const subFac1 = draft[idxMap['SubFac_1']].value
								draft[idxMap['Faction_1']].value = draft[idxMap['Faction_2']].value
								draft[idxMap['SubFac_1']].value = draft[idxMap['SubFac_2']].value
								draft[idxMap['Faction_2']].value = faction1
								draft[idxMap['SubFac_2']].value = subFac1
							})
						)
					}
					const swapFactionsDisabled =
						!store.menuItems.some(
							(comp) =>
								(comp.column === 'Faction_1' && comp.value !== undefined) || (comp.column === 'SubFac_1' && comp.value !== undefined)
						) &&
						!store.menuItems.some(
							(comp) =>
								(comp.column === 'Faction_2' && comp.value !== undefined) || (comp.column === 'SubFac_2' && comp.value !== undefined)
						)

					return (
						<React.Fragment key={name}>
							{(name === 'Level' || name === 'Faction_1') && <Separator className="col-span-4 my-2" />}
							{name === 'Faction_2' && (
								<>
									<Button disabled={swapFactionsDisabled} onClick={swapFactions} variant="secondary">
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
			<div>
				<Button variant="secondary" onClick={() => store.setMenuItems(getDefaultFilterMenuItemState({}))}>
					Clear All
				</Button>
			</div>
		</div>
	)
}
