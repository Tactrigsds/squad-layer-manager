import * as AR from '@/app-routes.ts'
import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog.tsx'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useFilter, useFilters } from '@/hooks/filters.ts'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useAreLayersInPool } from '@/hooks/use-layer-queries.ts'
import { useEndGame as useEndMatch, useSquadServerStatus } from '@/hooks/use-squad-server-status.ts'
import { useToast } from '@/hooks/use-toast'
import { useAbortVote, useStartVote, useVoteState } from '@/hooks/votes.ts'
import * as DH from '@/lib/display-helpers'
import * as EFB from '@/lib/editable-filter-builders'
import * as FB from '@/lib/filter-builders.ts'
import { initMutationState } from '@/lib/item-mutations.ts'
import { getDisplayedMutation, hasMutations } from '@/lib/item-mutations.ts'
import { deepClone, selectProps } from '@/lib/object.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import { useConfig } from '@/systems.client/config.client.ts'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import { useDragEnd } from '@/systems.client/dndkit.ts'
import { useLoggedInUser } from '@/systems.client/logged-in-user'
import * as PartsSys from '@/systems.client/parts.ts'
import { useUserPresenceState } from '@/systems.client/presence.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as RbacClient from '@/systems.client/rbac.client.ts'
import { trpc } from '@/trpc.client.ts'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { zodValidator } from '@tanstack/zod-form-adapter'
import deepEqual from 'fast-deep-equal'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Comparison } from './filter-card'
import LayerTable from './layer-table.tsx'
import { ServerUnreachable } from './server-offline-display.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import TabsList from './ui/tabs-list.tsx'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'
import VoteTallyDisplay from './votes-display.tsx'

export default function ServerDashboard() {
	const serverStatusRes = useSquadServerStatus()
	const settingsPanelRef = React.useRef<ServerSettingsPanelHandle>(null)

	const toaster = useToast()
	const updateQueueMutation = useMutation({
		mutationFn: trpc.layerQueue.updateQueue.mutate,
	})
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
			case 'err:queue-too-large':
				toaster.toast({
					title: 'Queue too large',
					variant: 'destructive',
				})
				break
			case 'err:empty-vote':
				toaster.toast({
					title: 'Cannot update: vote is empty',
					variant: 'destructive',
				})
				break
			case 'err:too-many-vote-choices':
				toaster.toast({
					title: res.msg,
					variant: 'destructive',
				})
				break
			case 'err:default-choice-not-in-choices':
				toaster.toast({
					title: 'Cannot update: default choice must be one of the vote choices',
					variant: 'destructive',
				})
				break
			case 'err:duplicate-vote-choices':
				toaster.toast({
					title: res.msg,
					variant: 'destructive',
				})
				break
			case 'ok':
				toaster.toast({ title: 'Changes applied' })
				QD.QDStore.getState().reset()
				break
			default:
				assertNever(res)
		}
	}

	const isEditing = Zus.useStore(QD.QDStore, (s) => s.isEditing)
	const layerQueryConstraints = ZusUtils.useStoreDeep(QD.QDStore, QD.selectQDQueryConstraints)
	const layerQueryContext: M.LayerQueryContext = { constraints: layerQueryConstraints, previousLayerIds: [] }
	const userPresenceState = useUserPresenceState()
	const editingUser = userPresenceState?.editState && PartsSys.findUser(userPresenceState.editState.userId)
	const loggedInUser = useLoggedInUser()

	const queueHasMutations = Zus.useStore(QD.LQStore, (s) => hasMutations(s.listMutations))
	const queueLength = Zus.useStore(QD.LQStore, (s) => s.layerList.length)
	const maxQueueSize = useConfig()?.maxQueueSize
	const hasKickPermission = loggedInUser
		&& RBAC.rbacUserHasPerms(loggedInUser, { check: 'any', permits: [RBAC.perm('queue:write'), RBAC.perm('settings:write')] })

	const kickEditorMutation = useMutation({
		mutationFn: () => trpc.layerQueue.kickEditor.mutate(),
	})
	const inEditTransition = Zus.useStore(QD.QDStore, (s) => s.stopEditingInProgress)
	const slmConfig = useConfig()
	return (
		<div className="contianer mx-auto grid place-items-center py-10">
			<div className="flex space-x-4">
				<VoteState />
				<div className="flex flex-col space-y-4">
					{/* ------- top card ------- */}
					<Card>
						{!isEditing && serverStatusRes && serverStatusRes?.code === 'err:rcon' && <ServerUnreachable statusRes={serverStatusRes} />}
						{!isEditing && serverStatusRes && serverStatusRes?.code === 'ok' && (!editingUser || inEditTransition) && (
							<>
								<CardHeader>
									<div className="flex items-center justify-between">
										<CardTitle>Now Playing</CardTitle>
										{DH.displayUnvalidatedLayer(serverStatusRes.data.currentLayer)}
									</div>
								</CardHeader>
								<CardContent className="flex justify-between">
									{slmConfig?.matchHistoryUrl && (
										<a className={buttonVariants({ variant: 'link', className: 'pl-0' })} target="_blank" href={slmConfig.matchHistoryUrl}>
											View Match History
										</a>
									)}
									<EndMatchDialog />
								</CardContent>
							</>
						)}
						{!isEditing && editingUser && !inEditTransition && (
							<Alert variant="info" className="flex justify-between items-center">
								<AlertTitle>
									{editingUser.discordId === loggedInUser?.discordId
										? 'You are editing on another tab'
										: editingUser.username + ' is editing'}
								</AlertTitle>
								<Button disabled={!hasKickPermission} onClick={() => kickEditorMutation.mutate()} variant="outline">
									Kick
								</Button>
							</Alert>
						)}
						{isEditing && !inEditTransition && (
							/* ------- editing card ------- */
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
										<Icons.LoaderCircle
											className="animate-spin data-[pending=false]:invisible"
											data-pending={updateQueueMutation.isPending}
										/>
									</CardFooter>
								</Card>
							</div>
						)}
					</Card>
					<Card className="">
						<CardHeader className="flex flex-row items-center justify-between">
							<CardTitle>Up Next</CardTitle>
							<CardDescription
								data-limitreached={queueLength >= (maxQueueSize ?? Infinity)}
								className="data-[limitreached=true]:text-destructive"
							>
								{queueLength} / {maxQueueSize}
							</CardDescription>
							<QueueControlPanel />
						</CardHeader>
						<CardContent>
							<LayerList
								store={QD.LQStore}
								onStartEdit={() => QD.QDStore.getState().tryStartEditing()}
								queryLayerContext={layerQueryContext}
							/>
						</CardContent>
					</Card>
				</div>
				<div>
					<ServerSettingsPanel ref={settingsPanelRef} />
				</div>
			</div>
		</div>
	)
}

function QueueControlPanel() {
	const [playNextPopoverOpen, _setPlayNextPopoverOpen] = React.useState(false)
	function setPlayNextPopoverOpen(v: boolean) {
		QD.QDStore.getState().tryStartEditing()
		_setPlayNextPopoverOpen(v)
	}

	const [appendLayersPopoverOpen, _setAppendLayersPopoverOpen] = React.useState(false)
	function setAppendLayersPopoverOpen(v: boolean) {
		QD.QDStore.getState().tryStartEditing()
		_setAppendLayersPopoverOpen(v)
	}
	const [canEdit, lqLength] = ZusUtils.useStoreDeep(
		QD.QDStore,
		useShallow((s) => [s.canEditQueue, s.editedServerState.layerQueue.length]),
	)
	const constraints = ZusUtils.useStoreDeep(QD.QDStore, QD.selectQDQueryConstraints)

	const addToQueueQueryContext = QD.useDerivedQueryContextForLQIndex(lqLength, { constraints }, QD.LQStore)
	const playNextQueryContext: M.LayerQueryContext = { constraints }

	return (
		<div className="flex items-center space-x-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="icon"
						disabled={!canEdit}
						onClick={() => {
							QD.LQStore.getState().clear()
						}}
					>
						<Icons.Trash />
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<p>Clear Queue</p>
				</TooltipContent>
			</Tooltip>
			<SelectLayersDialog
				title="Add to Queue"
				description="Select layers to add to the queue"
				selectQueueItems={(items) => QD.LQStore.getState().add(items)}
				open={appendLayersPopoverOpen}
				onOpenChange={setAppendLayersPopoverOpen}
				layerQueryContext={addToQueueQueryContext}
			>
				<Button disabled={!canEdit} className="flex w-min items-center space-x-1" variant="default">
					<Icons.PlusIcon />
					<span>Play After</span>
				</Button>
			</SelectLayersDialog>
			<SelectLayersDialog
				title="Play Next"
				description="Select layers to play next"
				selectQueueItems={(items) => QD.LQStore.getState().add(items, 0)}
				open={playNextPopoverOpen}
				onOpenChange={setPlayNextPopoverOpen}
				layerQueryContext={playNextQueryContext}
			>
				<Button disabled={!canEdit} className="flex w-min items-center space-x-1" variant="default">
					<Icons.PlusIcon />
					<span>Play Next</span>
				</Button>
			</SelectLayersDialog>
		</div>
	)
}

function EndMatchDialog() {
	const [isOpen, setIsOpen] = React.useState(false)

	const loggedInUser = useLoggedInUser()
	const endMatchMutation = useEndMatch()
	const serverStatusRes = useSquadServerStatus()
	if (!serverStatusRes || serverStatusRes?.code === 'err:rcon') return null
	const serverStatus = serverStatusRes.data

	async function endMatch() {
		setIsOpen(false)
		const res = await endMatchMutation.mutateAsync()
		switch (res.code) {
			case 'ok':
				globalToast$.next({ title: 'Match ended!' })
				break
			case 'err:permission-denied':
				RbacClient.showPermissionDenied(res)
				break
			case 'err':
				console.error(res)
				globalToast$.next({ title: 'error while ending match', variant: 'destructive' })
				break
			default:
				assertNever(res)
		}
	}

	const canEndMatch = !loggedInUser || RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:end-match'))
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button variant="destructive" disabled={!canEndMatch}>
					End Match
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>End Match</DialogTitle>
				</DialogHeader>
				<DialogDescription>
					Are you sure you want to end the match for <b>{serverStatus?.name}</b>?
				</DialogDescription>
				<DialogFooter>
					<Button disabled={!canEndMatch} onClick={endMatch} variant="destructive">
						End Match
					</Button>
					<Button
						onClick={() => {
							setIsOpen(false)
						}}
						variant="secondary"
					>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
export function LayerList(props: { store: Zus.StoreApi<QD.LLStore>; onStartEdit?: () => void; queryLayerContext: M.LayerQueryContext }) {
	const user = useLoggedInUser()
	const queueIds = Zus.useStore(
		props.store,
		useShallow((store) => store.layerList.map((item) => item.itemId)),
	)
	const isVoteChoice = Zus.useStore(props.store, store => store.isVoteChoice)
	const allowVotes = !isVoteChoice
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
			{queueIds.map((id, index) => (
				<LayerListItem
					llStore={props.store}
					allowVotes={allowVotes}
					key={id}
					itemId={id}
					index={index}
					isLast={index + 1 === queueIds.length}
					onStartEdit={props.onStartEdit}
					layerQueryContext={props.queryLayerContext}
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

	const userPresence = useUserPresenceState()
	const editInProgress = userPresence?.editState

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
			durationSeconds: (slmConfig?.defaults.voteDuration ?? 3000) / 1000,
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
				case 'err:rcon':
					toaster.toast({
						title: 'Failed to start vote: ' + res.code,
						description: res.msg,
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
	const canModifyVote = loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		&& !editInProgress

	if (!voteState || !squadServerStatus || squadServerStatus.code !== 'ok') return null
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
							disabled={!canModifyVote}
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
							disabled={!canModifyVote}
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
			disabled={!canModifyVote}
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
						disabled={!canModifyVote}
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
						<VoteTallyDisplay voteState={voteState} playerCount={squadServerStatus.data.playerCount} />
						{cancelBtn}
					</>
				)
			}
			break
		case 'ended:winner':
			body = (
				<>
					<VoteTallyDisplay voteState={voteState} playerCount={squadServerStatus.data.playerCount} />
					{rerunVoteBtn}
					{voteConfigElt}
				</>
			)
			break
		case 'ended:insufficient-votes':
		case 'ended:aborted': {
			const user = voteState.code === 'ended:aborted'
				? voteState.aborter.discordId && PartsSys.findUser(voteState.aborter.discordId)
				: null
			body = (
				<>
					<VoteTallyDisplay voteState={voteState} playerCount={squadServerStatus.data.playerCount} />
					<Alert variant="destructive">
						<AlertTitle>Vote Aborted</AlertTitle>
						{voteState.code === 'ended:insufficient-votes' && <AlertDescription>Insufficient votes to determine a winner</AlertDescription>}
						{voteState.code === 'ended:aborted'
							&& (user
								? <AlertDescription>Vote was manually aborted by {user.username}</AlertDescription>
								: <AlertDescription>Vote was Aborted</AlertDescription>)}
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
	const filterOptions = filtersRes.data?.filters.map?.((f) => ({
		value: f.id,
		label: f.name,
	}))
	const enableCheckboxId = React.useId()
	const loggedInUser = useLoggedInUser()
	const hasForceWrite = loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))
	return (
		<div className={cn('flex space-x-2 items-center', props.className)}>
			{props.allowToggle && (
				<>
					<Checkbox
						id={enableCheckboxId}
						disabled={!hasForceWrite}
						onCheckedChange={(v) => {
							if (v === 'indeterminate') return
							props.setEnabled?.(v)
						}}
						checked={props.enabled}
					/>
					<ComboBox
						title="Filter"
						disabled={!hasForceWrite}
						className="flex-grow"
						options={filterOptions ?? LOADING}
						allowEmpty={true}
						value={props.filterId}
						onSelect={(filter) => props.onSelect(filter ?? null)}
					/>
				</>
			)}
			{props.filterId && (
				<a className={buttonVariants({ variant: 'ghost', size: 'icon' })} target="_blank" href={AR.link('/filters/:id', props.filterId)}>
					<Icons.Edit />
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
	ref: React.ForwardedRef<ServerSettingsPanelHandle>,
) {
	const filtersRes = useQuery({
		queryKey: ['filters'],
		queryFn: () => trpc.filters.getFilters.query(),
	})

	const filterOptions = filtersRes.data?.filters.map?.((f) => ({
		value: f.id as string | null,
		label: f.name,
	})) ?? []
	filterOptions.push({ value: null, label: '<none>' })

	React.useImperativeHandle(ref, () => ({
		reset: () => {},
	}))
	const canEditSettings = Zus.useStore(QD.QDStore, (s) => s.canEditSettings)

	const poolFilterChanged = Zus.useStore(QD.QDStore, (s) => {
		if (!s.serverState) return null
		return s.serverState.settings.queue.poolFilterId !== s.editedServerState.settings.queue.poolFilterId
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
						data-edited={poolFilterChanged}
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
								})}
						/>
						{settings.queue.doNotRepeatRules.map((rule, index) => (
							<div key={index + '_' + rule.field} className="flex space-x-1 items-center">
								<Label>{rule.field}</Label>
								<Input
									type="number"
									value={rule.within}
									onChange={(e) => {
										setSetting((settings) => {
											settings.queue.doNotRepeatRules[index].within = Math.floor(Number(e.target.value))
										})
									}}
								/>
							</div>
						))}
						{settings.queue.poolFilterId && (
							<a
								className={buttonVariants({ variant: 'ghost', size: 'icon' })}
								target="_blank"
								href={AR.link('/filters/:id', settings.queue.poolFilterId)}
							>
								<Icons.Edit />
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
	const numItemsToGenerateId = React.useId()

	const [itemType, setItemType] = React.useState<'layer' | 'vote'>('layer')

	const [replaceCurrentGenerated, setReplaceCurrentGenerated] = React.useState(true)
	const replaceCurrentGeneratedId = React.useId()
	const itemTypeId = React.useId()
	const [numVoteChoices, setNumVoteChoices] = React.useState(3)
	const [numItemsToGenerate, setNumItemsToGenerate] = React.useState(5)
	const numVoteChoicesId = React.useId()
	const canEditQueue = Zus.useStore(QD.QDStore, (s) => s.canEditQueue)
	const slmConfig = useConfig()

	const genereateMutation = useMutation({
		mutationFn: generateLayerQueueItems,
	})

	async function generateLayerQueueItems() {
		let serverStateMut = QD.QDStore.getState().editedServerState
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
			while (true) {
				const state = QD.LQStore.getState()
				if (state.layerList.length === 0) break
				if (state.layerList[state.layerList.length - 1].source !== 'generated') break
				if (!state.listMutations.added.has(state.layerList[state.layerList.length - 1].itemId)) break
				const id = state.layerList[state.layerList.length - 1].itemId
				state.remove(id)
			}
		}

		const state = QD.LQStore.getState()
		state.add(generated)
	}

	return (
		<Card className="flex flex-col space-y-1">
			<CardHeader>
				<CardTitle>Queue Generation</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
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
							max={slmConfig?.maxNumVoteChoices}
							defaultValue={numVoteChoices}
							onChange={(e) => {
								setNumVoteChoices(parseInt(e.target.value) ?? 0)
							}}
						/>
					</div>
				)}
				<div className="flex space-x-1 items-center">
					<Checkbox
						id={replaceCurrentGeneratedId}
						checked={replaceCurrentGenerated}
						onCheckedChange={(v) => {
							if (v === 'indeterminate') return
							setReplaceCurrentGenerated(v)
						}}
					/>
					<Label htmlFor={replaceCurrentGeneratedId}>Replace current generated</Label>
				</div>
				<div className="flex space-x-2">
					<Button disabled={genereateMutation.isPending || !canEditQueue} onClick={() => genereateMutation.mutateAsync()}>
						Generate
					</Button>
					<Icons.LoaderCircle className="animate-spin data-[pending=false]:invisible" data-pending={genereateMutation.isPending} />
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
		item: M.LayerListItem
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

function getIndexFromQueueItemId(items: M.LayerListItem[], id: string | null) {
	if (id === null) return -1
	return items.findIndex((item) => item.itemId === id)
}

type QueueItemProps = {
	index: number
	isLast: boolean
	allowVotes?: boolean
	itemId: string
	llStore: Zus.StoreApi<QD.LLStore>
	onStartEdit?: () => void
	layerQueryContext: M.LayerQueryContext
}

function LayerListItem(props: QueueItemProps) {
	const itemStore = React.useMemo(() => QD.deriveLLItemStore(props.llStore, props.itemId), [props.llStore, props.itemId])
	const allowVotes = props.allowVotes ?? true
	const item = Zus.useStore(itemStore, (s) => s.item)
	const [canEdit, isEditing] = Zus.useStore(QD.QDStore, useShallow((s) => [s.canEditQueue, s.isEditing]))
	const draggableItemId = QD.toDraggableItemId(item.itemId)
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: draggableItemId,
	})

	const [dropdownOpen, _setDropdownOpen] = React.useState(false)
	const setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>> = (update) => {
		if (!canEdit) _setDropdownOpen(false)
		_setDropdownOpen(update)
	}

	const layerQueryContext = QD.useDerivedQueryContextForLQIndex(props.index, props.layerQueryContext, props.llStore)
	const style = { transform: CSS.Translate.toString(transform) }
	const itemDropdown = (
		<ItemDropdown
			allowVotes={allowVotes}
			index={props.index}
			open={dropdownOpen && canEdit}
			setOpen={setDropdownOpen}
			listStore={props.llStore}
			itemStore={itemStore}
			onStartEdit={props.onStartEdit}
			layerQueryContext={layerQueryContext}
		>
			<Button
				disabled={!canEdit}
				data-canedit={canEdit}
				className="invisible data-[canedit=true]:group-hover:visible"
				variant="ghost"
				size="icon"
			>
				<Icons.EllipsisVertical />
			</Button>
		</ItemDropdown>
	)
	const modifiedBy = item.lastModifiedBy && PartsSys.findUser(item.lastModifiedBy)
	const modifiedByDisplay = modifiedBy ? `- ${modifiedBy.username}` : ''
	const badges: React.ReactNode[] = []

	switch (item.source) {
		case 'gameserver':
			badges.push((<Badge key="source gameserver" variant="outline">Game Server</Badge>))
			break
		case 'generated':
			badges.push((<Badge key="source generated" variant="outline">Generated {modifiedByDisplay}</Badge>))
			break
		case 'manual': {
			badges.push((<Badge key="source manual" variant="outline">Manual {modifiedByDisplay}</Badge>))
			break
		}
		default:
			assertNever(item.source)
	}

	const queueItemStyles =
		`bg-background data-[mutation=added]:bg-added data-[mutation=moved]:bg-moved data-[mutation=edited]:bg-edited data-[is-dragging=true]:outline rounded-md bg-opacity-30 cursor-default`
	const serverStatus = useSquadServerStatus()
	let squadServerNextLayer: M.UnvalidatedMiniLayer | null = null
	if (serverStatus?.code === 'ok') squadServerNextLayer = serverStatus?.data.nextLayer ?? null

	const activeUnvalidatedLayer = M.getUnvalidatedLayerFromId(M.getActiveItemLayerId(item))

	if (
		!isEditing && squadServerNextLayer && props.index === 0 && !M.isLayerIdPartialMatch(activeUnvalidatedLayer.id, squadServerNextLayer.id)
	) {
		badges.push(
			<Tooltip key="not current next">
				<TooltipTrigger>
					<Badge variant="destructive">?</Badge>
				</TooltipTrigger>
				<TooltipContent>Not current next layer on server</TooltipContent>
			</Tooltip>,
		)
	}

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
			<Icons.GripVertical />
		</Button>
	)
	const indexElt = <span className="mr-2 font-light">{props.index + 1}.</span>

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
					{indexElt}
					<div className="h-full flex flex-col flex-grow">
						<label className={Typography.Muted}>Vote</label>
						<ol className={'flex flex-col space-y-1 items-start'}>
							{item.vote.choices.map((choice, index) => {
								const badges = choice === item.layerId ? [<Badge variant="added" key="layer chosen">chosen</Badge>] : []
								return (
									<li key={choice} className="flex items-center ">
										<span className="mr-2">{index + 1}.</span>
										<LayerDisplay layerId={choice} badges={badges} />
									</li>
								)
							})}
						</ol>
						<div className="flex space-x-1 items-center">{badges}</div>
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
					{indexElt}
					<div className="flex flex-col w-max flex-grow">
						<div className="flex items-center flex-shrink-0">
							<LayerDisplay layerId={item.layerId} />
						</div>
						<div className="flex space-x-1 items-center">{badges}</div>
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
	layerQueryContext: M.LayerQueryContext
	onStartEdit?: () => void
}) {
	const allowVotes = props.allowVotes ?? true

	type SubDropdownState = 'add-before' | 'add-after' | 'edit' | null
	const [subDropdownState, _setSubDropdownState] = React.useState(null as SubDropdownState)

	function setSubDropdownState(state: SubDropdownState) {
		if (state === null) props.setOpen(false)
		props.onStartEdit?.()
		_setSubDropdownState(state)
	}

	const user = useLoggedInUser()
	return (
		<DropdownMenu open={props.open || !!subDropdownState} onOpenChange={props.setOpen}>
			<DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuGroup>
					<EditLayerListItemDialogWrapper
						index={props.index}
						allowVotes={allowVotes}
						open={subDropdownState === 'edit'}
						onOpenChange={(update) => {
							const open = typeof update === 'function' ? update(subDropdownState === 'edit') : update
							return setSubDropdownState(open ? 'edit' : null)
						}}
						itemStore={props.itemStore}
						layerQueryContext={props.layerQueryContext}
					>
						<DropdownMenuItem>Edit</DropdownMenuItem>
					</EditLayerListItemDialogWrapper>
					<DropdownMenuItem
						onClick={() => {
							const id = props.itemStore.getState().item.itemId
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
						pinMode={!allowVotes ? 'layers' : undefined}
						selectingSingleLayerQueueItem={true}
						selectQueueItems={(items) => {
							const state = props.listStore.getState()
							state.add(items, props.index)
						}}
						layerQueryContext={props.layerQueryContext}
					>
						<DropdownMenuItem>Add layers before</DropdownMenuItem>
					</SelectLayersDialog>

					<SelectLayersDialog
						title="Add layers after"
						description="Select layers to add after"
						open={subDropdownState === 'add-after'}
						onOpenChange={(open) => setSubDropdownState(open ? 'add-after' : null)}
						pinMode={!allowVotes ? 'layers' : undefined}
						selectQueueItems={(items) => {
							const state = props.listStore.getState()
							state.add(items, props.index + 1)
						}}
						layerQueryContext={props.layerQueryContext}
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
							const itemIdx = props.listStore.getState().layerList.findIndex((i) => i.itemId === item.itemId)
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
							const itemIdx = layerList.findIndex((i) => i.itemId === item.itemId)
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

export function LayerDisplay(props: { layerId: M.LayerId; badges?: React.ReactNode[] }) {
	const poolFilterId = Zus.useStore(QD.QDStore, QD.selectCurrentPoolFilterId)
	const isLayerInPoolRes = useAreLayersInPool({ layers: [props.layerId], poolFilterId: poolFilterId }, {
		enabled: !M.isRawLayerId(props.layerId),
	})
	const filterRes = useFilter(poolFilterId)
	const badges: React.ReactNode[] = []
	if (props.badges) badges.push(...props.badges)

	if (isLayerInPoolRes.data && isLayerInPoolRes.data.code === 'ok') {
		const inPoolRes = isLayerInPoolRes.data.results[0]
		if (!inPoolRes.exists) {
			badges.push(
				<Tooltip key="layer doesn't exist">
					<TooltipTrigger>
						<Icons.ShieldQuestion className="text-orange-400" />
					</TooltipTrigger>
					<TooltipContent>
						Layer <b>{filterRes.data?.name} is unknown</b>
					</TooltipContent>
				</Tooltip>,
			)
		} else if (!inPoolRes.matchesFilter) {
			badges.push(
				<Tooltip key="layer not in configured pool">
					<TooltipTrigger>
						<Icons.ShieldQuestion className="text-orange-400" />
					</TooltipTrigger>
					<TooltipContent>
						Layer not in configured pool <b>{filterRes.data?.name}</b>
					</TooltipContent>
				</Tooltip>,
			)
		}
	}

	if (M.isRawLayerId(props.layerId)) {
		badges.push(
			<Tooltip key="is raw layer">
				<TooltipTrigger>
					<Icons.ShieldOff className="text-red-500" />
				</TooltipTrigger>
				<TooltipContent>
					<p>
						This layer is unknown and was not able to be fully parsed (<b>{props.layerId.slice('RAW:'.length)}</b>)
					</p>
				</TooltipContent>
			</Tooltip>,
		)
	}

	return (
		<div className="flex space-x-2 items-center">
			<span className="flex-1 text-nowrap">{DH.toShortLayerNameFromId(props.layerId)}</span>
			<span className="flex items-center space-x-1">
				{badges}
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
	selectQueueItems: (queueItems: M.NewLayerListItem[]) => void
	defaultSelected?: M.LayerId[]
	selectingSingleLayerQueueItem?: boolean
	open: boolean
	onOpenChange: (isOpen: boolean) => void
	layerQueryContext: M.LayerQueryContext
}) {
	const defaultSelected: M.LayerId[] = props.defaultSelected ?? []

	const filterMenuStore = useFilterMenuStore()

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
		if (selectMode === 'layers' || selectedLayers.length === 1) {
			const items = selectedLayers.map(
				(layerId) =>
					({
						layerId: layerId,
						source: 'manual',
						lastModifiedBy: user!.discordId,
					}) satisfies M.NewLayerListItem,
			)
			props.selectQueueItems(items)
		} else if (selectMode === 'vote') {
			const item: M.NewLayerListItem = {
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

	const queryContextWithFilter = useQueryContextWithMenuFilter(props.layerQueryContext, filterMenuStore)

	return (
		<Dialog open={props.open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0">
				<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
					<div className="flex items-center">
						<DialogTitle>{props.title}</DialogTitle>
						<div className="mx-8 font-light">-</div>
						<DialogDescription>{props.description}</DialogDescription>
					</div>
					<div className="flex items-center space-x-2">
						{!props.pinMode && (
							<TabsList
								options={[
									{ label: 'Vote', value: 'vote' },
									{ label: 'Set Layer', value: 'layers' },
								]}
								active={selectMode}
								setActive={setAdditionType}
							/>
						)}
					</div>
				</DialogHeader>

				<div className="flex min-h-0 items-start space-x-2">
					<LayerFilterMenu queryContext={props.layerQueryContext} filterMenuStore={filterMenuStore} />
					<TableStyleLayerPicker queryContext={queryContextWithFilter} selected={selectedLayers} onSelect={setSelectedLayers} />
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
	queryContext: M.LayerQueryContext
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
				queryContext={props.queryContext}
				defaultColumns={defaultColumns}
				pageIndex={pageIndex}
				autoSelectIfSingleResult={props.maxSelected === 1}
				setPageIndex={setPageIndex}
				selected={props.selected}
				setSelected={props.onSelect}
				maxSelected={props.maxSelected}
				enableForceSelect={true}
				defaultSortBy="random"
				defaultSortDirection="DESC"
				canChangeRowsPerPage={false}
				canToggleColumns={false}
			/>
		</div>
	)
}

function itemToLayerIds(item: M.LayerListItem): M.LayerId[] {
	let layers: M.LayerId[]
	if (item.vote) {
		layers = item.vote.choices
	} else if (item.layerId) {
		layers = [item.layerId]
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
	index: number
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	allowVotes?: boolean
	itemStore: Zus.StoreApi<QD.LLItemStore>
	layerQueryContext: M.LayerQueryContext
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

	const editedVoteChoiceStore = QD.useVoteChoiceStore(editedItemStore)

	const loggedInUser = useLoggedInUser()

	const [addLayersOpen, setAddLayersOpen] = React.useState(false)

	const unvalidatedLayer = editedItem.layerId ? M.getUnvalidatedLayerFromId(editedItem.layerId) : undefined
	const filterMenuStore = useFilterMenuStore(unvalidatedLayer ? M.getLayerDetailsFromUnvalidated(unvalidatedLayer) : undefined)

	const canSubmit = Zus.useStore(
		editedItemStore,
		(s) => !deepEqual(initialItem, s.item) && (!s.item.vote || s.item.vote.choices.length > 0),
	)
	function submit() {
		if (!canSubmit) return
		props.onOpenChange(false)
		props.itemStore.getState().setItem(editedItem)
	}
	const numChoices = Zus.useStore(editedVoteChoiceStore, s => s.layerList.length)

	const queryContextWithMenuFilter = useQueryContextWithMenuFilter(props.layerQueryContext, filterMenuStore)
	const addVoteQueryContext = QD.useDerivedQueryContextForLQIndex(numChoices, props.layerQueryContext, editedVoteChoiceStore)

	if (!props.allowVotes && editedItem.vote) throw new Error('Invalid queue item')

	return (
		<div className="w-full h-full">
			<DialogHeader className="flex flex-row whitespace-nowrap items-center justify-between mr-4">
				<div className="flex items-center">
					<DialogTitle>Edit</DialogTitle>
					<div className="mx-8 font-light">-</div>
					<DialogDescription>Change the layer or vote choices for this queue item.</DialogDescription>
				</div>
				<div className="flex items-center space-x-2">
					{allowVotes && (
						<TabsList
							options={[
								{ label: 'Vote', value: 'vote' },
								{ label: 'Set Layer', value: 'layer' },
							]}
							active={editedItem.vote ? 'vote' : 'layer'}
							setActive={(itemType) => {
								editedItemStore.getState().setItem((prev) => {
									const selectedLayerIds = itemToLayerIds(prev)
									const attribution = {
										source: 'manual' as const,
										lastModifiedBy: loggedInUser!.discordId,
									}
									if (itemType === 'vote') {
										return {
											itemId: prev.itemId,
											vote: {
												choices: selectedLayerIds,
												defaultChoice: selectedLayerIds[0],
											},
											...attribution,
										}
									} else if (itemType === 'layer') {
										return {
											itemId: prev.itemId,
											layerId: selectedLayerIds[0],
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

			{editedItem.vote
				? (
					<div className="flex flex-col">
						<div className="flex w-min"></div>
						<LayerList store={editedVoteChoiceStore} queryLayerContext={props.layerQueryContext} />
					</div>
				)
				: (
					<div className="flex items-start space-x-2 min-h-0">
						<LayerFilterMenu queryContext={props.layerQueryContext} filterMenuStore={filterMenuStore} />
						<TableStyleLayerPicker
							queryContext={queryContextWithMenuFilter}
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
						pinMode="layers"
						onOpenChange={setAddLayersOpen}
						layerQueryContext={addVoteQueryContext}
						selectQueueItems={(items) => {
							editedVoteChoiceStore.getState().add(items)
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

function getDefaultFilterMenuItemState(defaultFields: Partial<M.MiniLayer>): M.EditableComparison[] {
	return [
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

function getFilterFromComparisons(items: M.EditableComparison[]) {
	const nodes: M.FilterNode[] = []
	for (const item of items) {
		if (!M.isValidComparison(item)) continue
		nodes.push(FB.comp(item))
	}

	if (nodes.length === 0) return undefined
	return FB.and(nodes)
}

type FilterMenuStore = {
	filter?: M.FilterNode
	menuItems: M.EditableComparison[]
	siblingFilters: { [k in keyof M.MiniLayer]: M.FilterNode | undefined }
	setMenuItems: React.Dispatch<React.SetStateAction<M.EditableComparison[]>>
}

/**
 * Derive filter nodes which
 */
function getSiblingFiltersForMenuItems(items: M.EditableComparison[]) {
	// @ts-expect-error idc
	const filtersExcludingFields: { [k in keyof M.MiniLayer]: M.FilterNode | undefined } = {}
	for (let i = 0; i < items.length; i++) {
		const item = items[i]
		if (!item.column) continue
		const comparisonsToApply: M.FilterNode[] = []
		for (let j = 0; j < items.length; j++) {
			if (i === j) continue
			const cand = items[j]
			if (!M.isValidComparison(cand)) continue

			// don't filter out the composite columns based on the filter with a combined value, because that would be annoying
			if (item.column === 'Layer' && ['Level', 'Gamemode', 'LayerVersion'].includes(cand.column)) continue
			if (['Level', 'Gamemode', 'LayerVersion'].includes(item.column) && cand.column === 'Layer') continue
			comparisonsToApply.push(FB.comp(cand))
		}

		if (filtersExcludingFields[item.column as keyof M.MiniLayer]) {
			console.warn('unexpected duplicate detected when deriving sibling filters', items)
		}
		filtersExcludingFields[item.column as keyof M.MiniLayer] = comparisonsToApply.length > 0 ? FB.and(comparisonsToApply) : undefined
	}

	return filtersExcludingFields
}

function useFilterMenuStore(defaultFields: Partial<M.MiniLayer> = {}) {
	const store = React.useMemo(() => (
		Zus.createStore<FilterMenuStore>((set, get) => {
			const items = getDefaultFilterMenuItemState(defaultFields)
			const filter = getFilterFromComparisons(items)
			const siblingFilters = getSiblingFiltersForMenuItems(items)

			return {
				menuItems: items,
				filter,
				siblingFilters: siblingFilters,
				setMenuItems: (update) => {
					let updated: M.EditableComparison[]
					const state = get()
					if (typeof update === 'function') {
						updated = update(state.menuItems)
					} else {
						updated = update
					}

					const filter = getFilterFromComparisons(updated)
					const siblingFilters = getSiblingFiltersForMenuItems(updated)

					set({
						menuItems: updated,
						filter,
						siblingFilters,
					})
				},
			}
		})
	), [])
	return store
}

function useQueryContextWithMenuFilter(queryContext: M.LayerQueryContext, store: Zus.StoreApi<FilterMenuStore>) {
	const filter = Zus.useStore(store, s => s.filter)
	if (filter) {
		return {
			...queryContext,
			constraints: [...(queryContext.constraints ?? []), M.filterToConstraint(filter)],
		}
	} else {
		return queryContext
	}
}

function LayerFilterMenu(props: { filterMenuStore: Zus.StoreApi<FilterMenuStore>; queryContext: M.LayerQueryContext }) {
	const storeState = Zus.useStore(
		props.filterMenuStore,
		useShallow(state => selectProps(state, ['menuItems', 'siblingFilters'])),
	)

	function applySetFilterFieldComparison(name: keyof M.MiniLayer): React.Dispatch<React.SetStateAction<M.EditableComparison>> {
		return (update) => {
			props.filterMenuStore.getState().setMenuItems(
				// TODO having this be inline is kinda gross
				Im.produce((draft) => {
					const prevComp = draft.find((item) => item.column === name)!
					const comp = typeof update === 'function' ? update(prevComp) : update
					const idxMap: Record<string, number> = {}
					draft.forEach((item, idx) => {
						idxMap[item.column!] = idx
					})

					if (comp.column === 'Layer' && comp.value) {
						const parsedLayer = M.parseLayerStringSegment(comp.value as string)
						if (!parsedLayer) {
							return
						}
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
						draft[idxMap['Layer']].value = M.getLayerString(
							{
								Gamemode: draft[idxMap['Gamemode']].value!,
								Level: draft[idxMap['Level']].value!,
								LayerVersion: draft[idxMap['LayerVersion']].value!,
							} as Parameters<typeof M.getLayerString>[0],
						)
					} else {
						delete draft[idxMap['Layer']].value
					}
				}),
			)
		}
	}

	return (
		<div className="flex flex-col space-y-2">
			<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
				{storeState.menuItems.map((comparison) => {
					const name = comparison.column as keyof M.MiniLayer
					const setComp = applySetFilterFieldComparison(name)
					function clear() {
						setComp(
							Im.produce((prev) => {
								delete prev.value
							}),
						)
					}

					function swapFactions() {
						props.filterMenuStore.getState().setMenuItems(
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
							}),
						)
					}
					const swapFactionsDisabled = !storeState.menuItems.some(
						(comp) => (comp.column === 'Faction_1' && comp.value !== undefined) || (comp.column === 'SubFac_1' && comp.value !== undefined),
					)
						&& !storeState.menuItems.some(
							(comp) =>
								(comp.column === 'Faction_2' && comp.value !== undefined) || (comp.column === 'SubFac_2' && comp.value !== undefined),
						)
					let constraints = props.queryContext.constraints ?? []
					if (storeState.siblingFilters[name]) {
						constraints = [
							...constraints,
							M.filterToConstraint(storeState.siblingFilters[name]),
						]
					}

					return (
						<React.Fragment key={name}>
							{(name === 'Level' || name === 'Faction_1') && <Separator className="col-span-4 my-2" />}
							{name === 'Faction_2' && (
								<>
									<Button title="Swap Factions" disabled={swapFactionsDisabled} onClick={swapFactions} size="icon" variant="outline">
										<Icons.FlipVertical2 />
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
								layerQueryContext={{ ...props.queryContext, constraints }}
							/>
							<Button disabled={comparison.value === undefined} variant="ghost" size="icon" onClick={clear}>
								<Icons.Trash />
							</Button>
						</React.Fragment>
					)
				})}
			</div>
			<div>
				<Button variant="secondary" onClick={() => props.filterMenuStore.getState().setMenuItems(getDefaultFilterMenuItemState({}))}>
					Clear All
				</Button>
			</div>
		</div>
	)
}
