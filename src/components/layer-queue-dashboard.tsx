import * as AR from '@/app-routes.ts'
import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import MatchHistoryPanel from '@/components/match-history-panel.tsx'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useToast } from '@/hooks/use-toast'
import { useAbortVote, useStartVote, useVoteState } from '@/hooks/votes.ts'
import { hasMutations } from '@/lib/item-mutations.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import { useConfig } from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import { useLoggedInUser } from '@/systems.client/logged-in-user'
import * as PartsSys from '@/systems.client/parts.ts'
import { useUserPresenceState } from '@/systems.client/presence.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as RbacClient from '@/systems.client/rbac.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { trpc } from '@/trpc.client.ts'
import * as ReactRx from '@react-rxjs/core'
import { useForm } from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
import { zodValidator } from '@tanstack/zod-form-adapter'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import CurrentLayerCard from './current-layer-card.tsx'
import { LayerList } from './layer-list.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { ServerUnreachable } from './server-offline-display.tsx'
import { Timer } from './timer.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import VoteTallyDisplay from './votes-display.tsx'

export default function LayerQueueDashboard() {
	const serverStatusRes = SquadServerClient.useSquadServerStatus()
	const settingsPanelRef = React.useRef<PoolConfigurationPopoverHandle>(null)

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
	return (
		<div className="contianer mx-auto grid place-items-center py-10">
			<div className="flex space-x-4">
				<div>
					<MatchHistoryPanel />
				</div>
				<div className="flex flex-col space-y-4">
					{/* ------- top card ------- */}
					<Card>
						{!isEditing && serverStatusRes && serverStatusRes?.code === 'err:rcon' && <ServerUnreachable statusRes={serverStatusRes} />}
						{!isEditing && serverStatusRes && serverStatusRes?.code === 'ok' && (!editingUser || inEditTransition) && (
							<CurrentLayerCard serverStatus={serverStatusRes.data} />
						)}
						{!isEditing && editingUser && !inEditTransition && (
							<Alert variant="info" className="flex justify-between items-center">
								<AlertTitle className="flex space-x-2">
									{editingUser.discordId === loggedInUser?.discordId
										? 'You are editing on another tab'
										: editingUser.username + ' is editing'}
									{userPresenceState.editState?.startTime && (
										<>
											<span>:</span>
											<Timer start={userPresenceState.editState.startTime} />
										</>
									)}
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
				<VoteState />
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
			<PoolConfigurationPopover>
				<Button size="icon" variant="ghost" title="Pool Configuration">
					<Icons.Settings />
				</Button>
			</PoolConfigurationPopover>
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

// TODO this is all kinds of fucked up
function VoteState() {
	const abortVoteMutation = useAbortVote()
	const toaster = useToast()
	const voteState = useVoteState()
	const squadServerStatus = SquadServerClient.useSquadServerStatus()
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
						<Timer deadline={voteState.deadline} className={Typography.Blockquote} />
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
	allowEmpty?: boolean
	filterId: string | null
	onSelect: (filterId: string | null) => void
	allowToggle?: boolean
	enabled?: boolean
	setEnabled?: (enabled: boolean) => void
	excludedFilterIds?: M.FilterEntityId[]
	children?: React.ReactNode
}) {
	const filters = ReactRx.useStateObservable(FilterEntityClient.filterEntities$)
	const filterOptions = []
	for (const f of filters.values()) {
		if (!props.excludedFilterIds || !props.excludedFilterIds.includes(f.id)) {
			filterOptions.push({
				value: f.id,
				label: f.name,
			})
		}
	}
	const enableCheckboxId = React.useId()
	const loggedInUser = useLoggedInUser()
	const hasForceWrite = loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))
	return (
		<div className={cn('flex space-x-2 items-center flex-nowrap', props.className)}>
			{props.allowToggle && (
				<Checkbox
					id={enableCheckboxId}
					disabled={!hasForceWrite}
					onCheckedChange={(v) => {
						if (v === 'indeterminate') return
						props.setEnabled?.(v)
					}}
					checked={props.enabled}
				/>
			)}
			<ComboBox
				title="Filter"
				disabled={!hasForceWrite}
				className="flex-grow"
				options={filterOptions ?? LOADING}
				allowEmpty={props.allowEmpty ?? true}
				value={props.filterId}
				onSelect={(filter) => props.onSelect(filter ?? null)}
			>
				{props.children}
			</ComboBox>
			{props.filterId && (
				<a className={buttonVariants({ variant: 'ghost', size: 'icon' })} target="_blank" href={AR.link('/filters/:id', props.filterId)}>
					<Icons.Edit />
				</a>
			)}
		</div>
	)
}

type PoolConfigurationPopoverHandle = {
	reset(settings: M.ServerSettings): void
}
const PoolConfigurationPopover = React.forwardRef(function PoolConfigurationPopover(
	props: { children: React.ReactNode },
	ref: React.ForwardedRef<PoolConfigurationPopoverHandle>,
) {
	const filterOptions = []
	for (const f of ReactRx.useStateObservable(FilterEntityClient.filterEntities$).values()) {
		filterOptions.push({
			value: f.id as string | null,
			label: f.name,
		})
	}
	filterOptions.push({ value: null, label: '<none>' })

	React.useImperativeHandle(ref, () => ({
		reset: () => {},
	}))

	return (
		<Popover>
			<PopoverTrigger asChild>
				{props.children}
			</PopoverTrigger>
			<PopoverContent className="sm:max-w-[425px]" side="right">
				<div className="flex flex-col space-y-2">
					<h3 className="font-medium">Pool Configuration</h3>
					<PoolFiltersConfigurationPanel poolId="mainPool" />
					<PoolDoNotRepeatRulesConfigurationPanel poolId="mainPool" />
				</div>
			</PopoverContent>
		</Popover>
	)
})

function PoolFiltersConfigurationPanel({ poolId }: { poolId: 'mainPool' | 'generationPool' }) {
	const [filterIds, setSetting] = ZusUtils.useStoreDeep(
		QD.QDStore,
		s => [s.editedServerState.settings.queue[poolId].filters, s.setSetting],
	)

	const add = (filterId: M.FilterEntityId | null) => {
		if (filterId === null) return
		setSetting(s => {
			s.queue[poolId].filters.push(filterId)
		})
	}

	return (
		<div>
			<div>
				<h4 className={Typography.H4}>Filters</h4>
			</div>
			<ul>
				{filterIds.map((filterId, i) => {
					const onSelect = (newFilterId: string | null) => {
						if (newFilterId === null) {
							return
						}
						setSetting(s => {
							s.queue[poolId].filters[i] = newFilterId
						})
					}
					const deleteFilter = () => {
						setSetting(s => {
							s.queue[poolId].filters.splice(i, 1)
						})
					}
					const excluded = filterIds.filter((id) => filterId !== id)

					return (
						<li className="flex space-x-1 items-center" key={filterId}>
							<FilterEntitySelect
								className="flex-grow"
								title="Pool Filter"
								filterId={filterId}
								onSelect={onSelect}
								allowToggle={false}
								allowEmpty={false}
								excludedFilterIds={excluded}
							/>
							<Button size="icon" variant="ghost" onClick={() => deleteFilter()}>
								<Icons.Minus />
							</Button>
						</li>
					)
				})}
				<FilterEntitySelect title="New Pool Filter" filterId={null} onSelect={add} excludedFilterIds={filterIds} allowEmpty={false}>
					<Button size="icon" variant="ghost">
						<Icons.Plus />
					</Button>
				</FilterEntitySelect>
			</ul>
		</div>
	)
}

function PoolDoNotRepeatRulesConfigurationPanel({ poolId }: { poolId: 'mainPool' | 'generationPool' }) {
	const rules = Zus.useStore(QD.QDStore, (s) => s.editedServerState.settings.queue[poolId].doNotRepeatRules)
	const setSetting = Zus.useStore(QD.QDStore, (s) => s.setSetting)

	return (
		<div className="flex flex-col space-y-1 p-1 rounded">
			<div>
				<h4 className={Typography.H4}>Do Not Repeat Rules</h4>
			</div>
			{rules.map((rule, index) => (
				<div key={index + '_' + rule.field} className="flex space-x-1 items-center">
					<Label>{rule.field}</Label>
					<Input
						type="number"
						defaultValue={rule.within}
						onChange={(e) => {
							setSetting((settings) => {
								settings.queue[poolId].doNotRepeatRules[index].within = Math.floor(Number(e.target.value))
							})
						}}
					/>
				</div>
			))}
		</div>
	)
}

// function HideOutOfPoolItemsPanel() {
//    const dnrCheckboxId = React.useId()
//    const poolFilterCheckboxId = React.useId()
//    return <div>

//       </div>
// }
