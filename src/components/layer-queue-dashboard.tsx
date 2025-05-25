import LayerComponents from '$root/assets/layer-components.json'
import MatchHistoryPanel from '@/components/match-history-panel.tsx'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useToast } from '@/hooks/use-toast'
import { useAbortVote, useStartVote, useVoteState } from '@/hooks/votes.ts'
import { TeamIndicator } from '@/lib/display-helpers-teams.tsx'
import * as DH from '@/lib/display-helpers.ts'
import { hasMutations } from '@/lib/item-mutations.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import { useConfig } from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as LayerQueueClient from '@/systems.client/layer-queue.client'
import * as PartsSys from '@/systems.client/parts.ts'
import { useUserPresenceState } from '@/systems.client/presence.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as RbacClient from '@/systems.client/rbac.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import { trpc } from '@/trpc.client.ts'
import { useForm } from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
import { zodValidator } from '@tanstack/zod-form-adapter'
import deepEqual from 'fast-deep-equal'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import CurrentLayerCard from './current-layer-card.tsx'
import FilterEntitySelect from './filter-entity-select.tsx'
import { LayerList } from './layer-list.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { ServerUnreachable } from './server-offline-display.tsx'
import { Timer } from './timer.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'
import VoteTallyDisplay from './votes-display.tsx'

export default function LayerQueueDashboard() {
	const serverStatusRes = SquadServerClient.useSquadServerStatus()

	// -------- set title --------
	React.useEffect(() => {
		if (!serverStatusRes) return
		if (serverStatusRes.code !== 'ok') {
			document.title = 'Squad Layer Manager'
		} else if (serverStatusRes.code === 'ok') {
			document.title = `SLM - ${serverStatusRes.data.name}`
		}
	}, [serverStatusRes])

	const isEditing = Zus.useStore(QD.QDStore, (s) => s.isEditing)
	const userPresenceState = useUserPresenceState()
	const editingUser = userPresenceState?.editState
		&& PartsSys.findUser(userPresenceState.editState.userId)

	const queueLength = Zus.useStore(QD.LQStore, (s) => s.layerList.length)
	const maxQueueSize = useConfig()?.maxQueueSize
	const updatesToSquadServerDisabled = Zus.useStore(QD.QDStore, s => s.serverState?.settings.updatesToSquadServerDisabled)
	const unexpectedNextLayer = LayerQueueClient.useUnexpectedNextLayer()
	const inEditTransition = Zus.useStore(
		QD.QDStore,
		(s) => s.stopEditingInProgress,
	)
	return (
		<div className="mx-auto grid place-items-center">
			<div className="w-full flex justify-end">
				<NormTeamsSwitch />
			</div>
			<div className="flex space-x-4">
				<div>
					<MatchHistoryPanel />
				</div>
				<div className="flex flex-col space-y-4">
					{/* ------- top card ------- */}
					{serverStatusRes?.code === 'err:rcon' && <ServerUnreachable statusRes={serverStatusRes} />}
					{serverStatusRes?.code === 'ok' && <CurrentLayerCard />}
					{!isEditing && editingUser && !inEditTransition && <UserEditingAlert />}
					{isEditing && !inEditTransition && <EditingCard />}
					{!updatesToSquadServerDisabled && unexpectedNextLayer && <UnexpectedNextLayerAlert />}
					{updatesToSquadServerDisabled && <SyncToSquadServerDisabledAlert />}
					<Card>
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
							/>
						</CardContent>
					</Card>
				</div>
				<div>
					<VoteState />
				</div>
			</div>
		</div>
	)
}

function NormTeamsSwitch() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const switchId = React.useId()

	const onCheckedChange = (checked: boolean | 'indeterminate') => {
		if (checked === 'indeterminate') return
		globalSettings.setDisplayTeamsNormalized(checked)
	}

	return (
		<div className="flex space-x-1 items-center p-2">
			<Switch
				id={switchId}
				defaultChecked={globalSettings.displayTeamsNormalized}
				onCheckedChange={onCheckedChange}
			/>
			<Label className="cursor-pointer" htmlFor={switchId}>
				Normalize Teams {globalSettings.displayTeamsNormalized
					? (
						<span>
							(left: <TeamIndicator team="teamA" /> right: <TeamIndicator team="teamB" />)
						</span>
					)
					: (
						<span>
							(left: <TeamIndicator team="team1" /> right: <TeamIndicator team="team2" />)
						</span>
					)}
			</Label>
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
	const canEdit = ZusUtils.useStoreDeep(QD.QDStore, (s) => s.canEditQueue)

	const addToQueueQueryContext = ZusUtils.useStoreDeep(QD.LQStore, (state) => QD.selectLayerListQueryContext(state, state.layerList.length))
	const playNextQueryContext = ZusUtils.useStoreDeep(QD.LQStore, (state) => QD.selectLayerListQueryContext(state, 0))

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
				<Button
					disabled={!canEdit}
					className="flex w-min items-center space-x-1"
					variant="default"
				>
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
				<Button
					disabled={!canEdit}
					className="flex w-min items-center space-x-1"
					variant="default"
				>
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

function EditingCard() {
	const queueHasMutations = Zus.useStore(QD.LQStore, (s) => hasMutations(s.listMutations))
	const updateQueueMutation = useMutation({
		mutationFn: trpc.layerQueue.updateQueue.mutate,
	})
	const toaster = useToast()

	async function saveLqState() {
		const serverStateMut = QD.QDStore.getState().editedServerState
		const res = await updateQueueMutation.mutateAsync(serverStateMut)
		const reset = QD.QDStore.getState().reset
		switch (res.code) {
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
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
	const queueMutations = Zus.useStore(QD.LQStore, (s) => s.listMutations)
	const settingsEdited = Zus.useStore(
		QD.QDStore,
		(s) =>
			s.serverState?.settings
			&& !deepEqual(s.serverState.settings, s.editedServerState.settings),
	)

	return (
		<Card>
			<CardHeader>
				<CardTitle>Changes Pending</CardTitle>
			</CardHeader>
			<CardContent className="flex justify-between py-0">
				<div className="space-y-1">
					{queueHasMutations && (
						<>
							<span className="flex space-x-1">
								{queueMutations.added.size > 0 && (
									<Badge variant="added">
										{queueMutations.added.size} layers added
									</Badge>
								)}
								{queueMutations.removed.size > 0 && (
									<Badge variant="removed">
										{queueMutations.removed.size} layers deleted
									</Badge>
								)}
								{queueMutations.moved.size > 0 && (
									<Badge variant="moved">
										{queueMutations.moved.size} layers moved
									</Badge>
								)}
								{queueMutations.edited.size > 0 && (
									<Badge variant="edited">
										{queueMutations.edited.size} layers edited
									</Badge>
								)}
							</span>
						</>
					)}
					{settingsEdited && <Badge variant="edited">settings modified</Badge>}
				</div>
				<div className="space-x-1 flex items-center">
					<Icons.LoaderCircle
						className="animate-spin data-[pending=false]:invisible"
						data-pending={updateQueueMutation.isPending}
					/>
					<Button
						onClick={saveLqState}
						disabled={updateQueueMutation.isPending}
					>
						Save Changes
					</Button>
					<Button
						onClick={() => QD.QDStore.getState().reset()}
						variant="secondary"
					>
						Cancel
					</Button>
				</div>
			</CardContent>
		</Card>
	)
}

function UserEditingAlert() {
	const userPresenceState = useUserPresenceState()
	const editingUser = userPresenceState?.editState
		&& PartsSys.findUser(userPresenceState.editState.userId)
	const loggedInUser = useLoggedInUser()
	const hasKickPermission = loggedInUser
		&& RBAC.rbacUserHasPerms(loggedInUser, {
			check: 'any',
			permits: [RBAC.perm('queue:write'), RBAC.perm('settings:write')],
		})
	const kickEditorMutation = useMutation({
		mutationFn: () => trpc.layerQueue.kickEditor.mutate(),
	})

	if (!userPresenceState || !editingUser) return null

	return (
		<Alert variant="info" className="flex justify-between items-center">
			<AlertTitle className="flex space-x-2">
				{editingUser.discordId === loggedInUser?.discordId
					? 'You are editing on another tab'
					: editingUser.username + ' is editing'}
				{userPresenceState.editState?.startTime && (
					<>
						<span>:</span>
						<Timer zeros={true} start={userPresenceState.editState.startTime} />
					</>
				)}
			</AlertTitle>
			<Button
				disabled={!hasKickPermission}
				onClick={() => kickEditorMutation.mutate()}
				variant="outline"
			>
				Kick
			</Button>
		</Alert>
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
		},
		validatorAdapter: zodValidator(),
		onSubmit: async ({ value }) => {
			const res = await startVoteMutation.mutateAsync({
				durationSeconds: value.durationSeconds,
			})
			switch (res.code) {
				case 'ok':
					toaster.toast({ title: 'Vote started!' })
					break
				case 'err:permission-denied':
					RbacClient.handlePermissionDenied(res)
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
	const canModifyVote = loggedInUser
		&& RBAC.rbacUserHasPerms(loggedInUser, {
			check: 'all',
			permits: [RBAC.perm('vote:manage')],
		})
		&& !editInProgress

	if (!voteState || !squadServerStatus || squadServerStatus.code !== 'ok') {
		return null
	}
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
						{field.state.meta.errors.length > 0 && (
							<Alert variant="destructive">
								{field.state.meta.errors.join(', ')}
							</Alert>
						)}
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
						<Timer
							deadline={voteState.deadline}
							className={Typography.Blockquote}
						/>
						<VoteTallyDisplay
							voteState={voteState}
							playerCount={squadServerStatus.data.playerCount}
						/>
						{cancelBtn}
					</>
				)
			}
			break
		case 'ended:winner':
			body = (
				<>
					<VoteTallyDisplay
						voteState={voteState}
						playerCount={squadServerStatus.data.playerCount}
					/>
					{rerunVoteBtn}
					{voteConfigElt}
				</>
			)
			break
		case 'ended:insufficient-votes':
		case 'ended:aborted': {
			const user = voteState.code === 'ended:aborted'
				? voteState.aborter.discordId
					&& PartsSys.findUser(voteState.aborter.discordId)
				: null
			body = (
				<>
					<VoteTallyDisplay
						voteState={voteState}
						playerCount={squadServerStatus.data.playerCount}
					/>
					<Alert variant="destructive">
						<AlertTitle>Vote Aborted</AlertTitle>
						{voteState.code === 'ended:insufficient-votes' && (
							<AlertDescription>
								Insufficient votes to determine a winner
							</AlertDescription>
						)}
						{voteState.code === 'ended:aborted'
							&& (user
								? (
									<AlertDescription>
										Vote was manually aborted by {user.username}
									</AlertDescription>
								)
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
		<Card className="w-min min-w-[200px]">
			<CardHeader>
				<CardTitle>Vote</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col space-y-2">{body}</CardContent>
		</Card>
	)
}

type PoolConfigurationPopoverHandle = {
	reset(settings: M.ServerSettings): void
}
const PoolConfigurationPopover = React.forwardRef(
	function PoolConfigurationPopover(
		props: { children: React.ReactNode },
		ref: React.ForwardedRef<PoolConfigurationPopoverHandle>,
	) {
		const filterOptions = []
		for (const f of FilterEntityClient.useFilterEntities().values()) {
			filterOptions.push({
				value: f.id as string | null,
				label: f.name,
			})
		}
		filterOptions.push({ value: null, label: '<none>' })

		React.useImperativeHandle(ref, () => ({
			reset: () => {},
		}))

		const [poolId, setPoolId] = React.useState<'mainPool' | 'generationPool'>(
			'mainPool',
		)
		const saveChangesMutation = QD.useSaveChangesMutation()

		const storedSettingsChanged = Zus.useStore(
			QD.QDStore,
			(state) =>
				!deepEqual(
					state.serverState?.settings,
					state.editedServerState.settings,
				),
		)
		const [storedMainPoolDnrRules, storedGenerationPoolDnrRules] = ZusUtils.useStoreDeep(
			QD.QDStore,
			(s) => [
				s.editedServerState.settings.queue.mainPool.doNotRepeatRules,
				s.editedServerState.settings.queue.generationPool.doNotRepeatRules,
			],
		)
		const [mainPoolRules, setMainPoolRules] = React.useState(storedMainPoolDnrRules)
		const [generationPoolRules, setGenerationPoolRules] = React.useState(
			[...storedGenerationPoolDnrRules],
		)
		React.useEffect(() => {
			setMainPoolRules(storedMainPoolDnrRules)
			setGenerationPoolRules(storedGenerationPoolDnrRules)
		}, [storedMainPoolDnrRules, storedGenerationPoolDnrRules])
		const settingsChanged = React.useMemo(() => {
			const mainPoolRulesChanged = !deepEqual(storedMainPoolDnrRules, mainPoolRules)
			const generationPoolRulesChanged = !deepEqual(storedGenerationPoolDnrRules, generationPoolRules)
			const res = storedSettingsChanged || mainPoolRulesChanged || generationPoolRulesChanged
			return res
		}, [
			storedSettingsChanged,
			storedMainPoolDnrRules,
			mainPoolRules,
			storedGenerationPoolDnrRules,
			generationPoolRules,
		])

		function saveRules() {
			QD.QDStore.getState().setSetting((settings) => {
				settings.queue.mainPool.doNotRepeatRules = [...mainPoolRules]
				settings.queue.generationPool.doNotRepeatRules = [...generationPoolRules]
				return settings
			})
		}

		const [open, _setOpen] = React.useState(false)
		const setOpen = (open: boolean) => {
			if (!open) {
				saveRules()
			}
			_setOpen(open)
		}

		const applyMainPool = Zus.useStore(QD.QDStore, s => s.editedServerState.settings.queue.applyMainPoolToGenerationPool)
		const applymainPoolSwitchId = React.useId()

		function setApplyMainPool(checked: boolean | 'indeterminate') {
			if (checked === 'indeterminate') return
			QD.QDStore.getState().setSetting((settings) => {
				settings.queue.applyMainPoolToGenerationPool = checked
			})
		}

		return (
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>{props.children}</PopoverTrigger>
				<PopoverContent
					className="w-[700px] flex flex-col space-y-2"
					side="right"
				>
					<div className="flex items-center justify-between">
						<h3 className="font-medium">Pool Configuration</h3>
						<div className="flex items-center space-x-2">
							<div className={cn('flex items-center space-x-1', poolId === 'generationPool' ? '' : 'invisible')}>
								<Label htmlFor={applymainPoolSwitchId}>Apply Main Pool</Label>
								<Switch id={applymainPoolSwitchId} checked={applyMainPool} onCheckedChange={setApplyMainPool} />
							</div>
							<TabsList
								options={[
									{ label: 'Main Pool', value: 'mainPool' },
									{ label: 'Autogeneration', value: 'generationPool' },
								]}
								active={poolId}
								setActive={setPoolId}
							/>
						</div>
					</div>
					<PoolFiltersConfigurationPanel poolId={poolId} />
					<PoolDoNotRepeatRulesConfigurationPanel
						className={poolId !== 'mainPool' ? 'hidden' : undefined}
						poolId="mainPool"
						rules={mainPoolRules}
						setRules={setMainPoolRules}
					/>
					<PoolDoNotRepeatRulesConfigurationPanel
						className={poolId !== 'generationPool' ? 'hidden' : undefined}
						poolId="generationPool"
						rules={generationPoolRules}
						setRules={setGenerationPoolRules}
					/>
					<Button
						disabled={!settingsChanged}
						onClick={() => {
							saveRules()
							saveChangesMutation.mutate()
							_setOpen(false)
						}}
					>
						Save Changes
					</Button>
				</PopoverContent>
			</Popover>
		)
	},
)

function PoolFiltersConfigurationPanel({
	poolId,
}: {
	poolId: 'mainPool' | 'generationPool'
}) {
	const [filterIds, setSetting] = ZusUtils.useStoreDeep(QD.QDStore, (s) => [
		s.editedServerState.settings.queue[poolId].filters,
		s.setSetting,
	])

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	const add = (filterId: M.FilterEntityId | null) => {
		if (filterId === null) return
		setSetting((s) => {
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
						setSetting((s) => {
							s.queue[poolId].filters[i] = newFilterId
						})
					}
					const deleteFilter = () => {
						setSetting((s) => {
							s.queue[poolId].filters.splice(i, 1)
						})
					}
					const excluded = filterIds.filter((id) => filterId !== id)

					return (
						<li className="flex space-x-1 items-center" key={filterId}>
							<FilterEntitySelect
								enabled={canWriteSettings ?? false}
								className="flex-grow"
								title="Pool Filter"
								filterId={filterId}
								onSelect={onSelect}
								allowToggle={false}
								allowEmpty={false}
								excludedFilterIds={excluded}
							/>
							<Button
								disabled={!canWriteSettings}
								size="icon"
								variant="ghost"
								onClick={() => deleteFilter()}
							>
								<Icons.Minus />
							</Button>
						</li>
					)
				})}
				<FilterEntitySelect
					title="New Pool Filter"
					filterId={null}
					onSelect={add}
					excludedFilterIds={filterIds}
					allowEmpty={false}
					enabled={canWriteSettings ?? false}
				>
					<Button disabled={!canWriteSettings} size="icon" variant="ghost">
						<Icons.Plus />
					</Button>
				</FilterEntitySelect>
			</ul>
		</div>
	)
}

type SaveChangesHandle = {
	saveChanges: () => void
}

function PoolDoNotRepeatRulesConfigurationPanel(props: {
	className?: string
	poolId: 'mainPool' | 'generationPool'
	rules: M.DoNotRepeatRule[]
	setRules: React.Dispatch<React.SetStateAction<M.DoNotRepeatRule[]>>
}) {
	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	return (
		<div className={cn('flex flex-col space-y-1 p-1 rounded', props.className)}>
			<div>
				<h4 className={Typography.H4}>Do Not Repeat Rules</h4>
			</div>
			{props.rules.map((rule, index) => {
				let targetValueOptions: string[]
				switch (rule.field) {
					case 'Map':
						targetValueOptions = LayerComponents.maps
						break
					case 'Layer':
						targetValueOptions = LayerComponents.layers
						break
					case 'Gamemode':
						targetValueOptions = LayerComponents.gamemodes
						break
					case 'Faction':
						targetValueOptions = LayerComponents.factions
						break
					case 'FactionAndUnit':
						throw new Error('FactionAndUnit is not a valid field')
						break
					default:
						assertNever(rule.field)
				}
				return (
					<div
						key={index + '_' + rule.field}
						className="flex space-x-1 items-center"
					>
						<Input
							placeholder="Label"
							defaultValue={rule.label ?? rule.field}
							containerClassName="grow-0"
							disabled={!canWriteSettings}
							onChange={(e) => {
								props.setRules(
									Im.produce((draft) => {
										draft[index].label = e.target.value
									}),
								)
							}}
						/>
						<ComboBox
							title={'Rule'}
							options={M.DnrFieldSchema.options.filter(
								(o) => o !== 'FactionAndUnit',
							)}
							value={rule.field}
							allowEmpty={false}
							onSelect={(value) => {
								if (!value) return
								props.setRules(
									Im.produce((draft) => {
										draft[index].field = value as M.DnrField
										draft[index].label = value
										delete draft[index].targetValues
									}),
								)
							}}
							disabled={!canWriteSettings}
						/>
						<Input
							type="number"
							defaultValue={rule.within}
							containerClassName="w-[250px]"
							disabled={!canWriteSettings}
							onChange={(e) => {
								props.setRules(
									Im.produce((draft) => {
										draft[index].within = Math.floor(Number(e.target.value))
									}),
								)
							}}
						/>
						<ComboBoxMulti
							className="flex-grow"
							title="Target Values"
							options={targetValueOptions}
							disabled={!canWriteSettings}
							values={rule.targetValues ?? []}
							onSelect={(updated) => {
								props.setRules(
									Im.produce((draft) => {
										// @ts-expect-error idgaf
										draft[index].targetValues = typeof updated === 'function'
											? updated(draft[index].targetValues ?? [])
											: updated
									}),
								)
							}}
						/>
						<Button
							size="icon"
							variant="ghost"
							onClick={() => {
								props.setRules(
									Im.produce((draft) => {
										draft.splice(index, 1)
									}),
								)
							}}
							disabled={!canWriteSettings}
						>
							<Icons.Minus />
						</Button>
					</div>
				)
			})}
			<Button
				size="icon"
				variant="ghost"
				disabled={!canWriteSettings}
				onClick={() => {
					props.setRules(
						Im.produce((draft) => {
							draft.push({
								field: 'Map',
								within: 0,
								label: 'Map',
							})
						}),
					)
				}}
			>
				<Icons.Plus />
			</Button>
		</div>
	)
}
function UnexpectedNextLayerAlert() {
	const unexpectedNextLayer = LayerQueueClient.useUnexpectedNextLayer()
	const expectedNextLayer = Zus.useStore(
		QD.QDStore,
		state => state.serverState ? M.getNextLayerId(state.serverState?.layerQueue) : undefined,
	)

	if (!unexpectedNextLayer) return null

	const actualLayerName = DH.toFullLayerNameFromId(unexpectedNextLayer)
	const expectedLayerName = expectedNextLayer ? DH.toFullLayerNameFromId(expectedNextLayer) : 'Unknown'

	return (
		<Alert variant="destructive">
			<AlertTitle>Current next layer on the server is out-of-sync with queue.</AlertTitle>
			<AlertDescription>
				Got <b>{actualLayerName}</b> but expected <b>{expectedLayerName}</b>
			</AlertDescription>
		</Alert>
	)
}

function SyncToSquadServerDisabledAlert() {
	const { enableUpdates } = QD.useToggleSquadServerUpdates()
	const serverStatusRes = SquadServerClient.useSquadServerStatus()
	const loggedInUser = useLoggedInUser()
	const hasDisableUpdatesPerm = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:disable-slm-updates'))
	const nextLayerDisplay = (serverStatusRes.code === 'ok' && serverStatusRes.data.nextLayer)
		? (
			<>
				Next Layer is set to: <b>{DH.displayUnvalidatedLayer(serverStatusRes.data.nextLayer)}</b>t
			</>
		)
		: ''
	return (
		<Alert variant="destructive">
			<AlertTitle>Updates to Squad Server have been Disabled</AlertTitle>
			<div className="flex items-center justify-between">
				<AlertDescription>
					<p>
						SLM is not currently syncing layers in the queue to{' '}
						<b>{serverStatusRes.code === 'ok' ? serverStatusRes.data.name : 'Squad Server'}</b>.
					</p>
					<p>
						{nextLayerDisplay}
					</p>
				</AlertDescription>
				<Button onClick={enableUpdates} disabled={!hasDisableUpdatesPerm} variant="secondary">Re-Enable</Button>
			</div>
		</Alert>
	)
}
