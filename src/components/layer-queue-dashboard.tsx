import MatchHistoryPanel from '@/components/match-history-panel.tsx'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useToast } from '@/hooks/use-toast'
import { TeamIndicator } from '@/lib/display-helpers-teams.tsx'
import * as DH from '@/lib/display-helpers.ts'
import { hasMutations } from '@/lib/item-mutations.ts'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as BAL from '@/models/balance-triggers.models'
import * as F from '@/models/filter.models.ts'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import * as RBAC from '@/rbac.models'
import { useConfig } from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as LayerQueueClient from '@/systems.client/layer-queue.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as PartsSys from '@/systems.client/parts.ts'
import { useUserPresenceState } from '@/systems.client/presence.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as RbacClient from '@/systems.client/rbac.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import { trpc } from '@/trpc.client.ts'
import { useMutation } from '@tanstack/react-query'
import deepEqual from 'fast-deep-equal'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import BalanceTriggerAlert from './balance-trigger-alert.tsx'
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

export default function LayerQueueDashboard() {
	const serverStatusRes = SquadServerClient.useServerInfoRes()

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
	const inEditTransition = Zus.useStore(QD.QDStore, (s) => s.stopEditingInProgress)
	type Tab = 'history' | 'queue'
	const [activeTab, setActiveTab] = React.useState<Tab>('queue')

	return (
		<div className="mx-auto grid place-items-center">
			{/* Mobile/Tablet: Show tabs */}
			<div className="w-full flex justify-between items-center pb-2 dash-2col:hidden">
				<TabsList
					active={activeTab}
					options={[{ label: 'History', value: 'history' }, { label: 'Queue', value: 'queue' }]}
					setActive={setActiveTab}
				/>
				<NormTeamsSwitch />
			</div>
			{/* Desktop: Show only NormTeamsSwitch */}
			<div className="w-full justify-end pb-2 hidden dash-2col:flex">
				<NormTeamsSwitch />
			</div>
			<div className="w-full dash-2col:flex dash-2col:space-x-4">
				{/* History Panel */}
				<div className={`${activeTab === 'history' ? '' : 'hidden'} dash-2col:block`}>
					<MatchHistoryPanel />
				</div>
				{/* Queue Panel */}
				<div className={`flex flex-col space-y-4 ${activeTab === 'queue' ? '' : 'hidden'} dash-2col:block`}>
					{/* ------- top card ------- */}
					{serverStatusRes?.code === 'err:rcon' && <ServerUnreachable statusRes={serverStatusRes} />}
					{serverStatusRes?.code === 'ok' && <CurrentLayerCard />}
					{!updatesToSquadServerDisabled && unexpectedNextLayer && <UnexpectedNextLayerAlert />}
					{updatesToSquadServerDisabled && <SyncToSquadServerDisabledAlert />}
					<PostGameBalanceTriggerAlert />
					{!isEditing && editingUser && !inEditTransition && <UserEditingAlert />}
					{isEditing && !inEditTransition && <EditingCard />}
					<Card>
						<CardHeader className="flex flex-row items-center justify-between">
							<span className="flex items-center space-x-1">
								<CardTitle>Up Next</CardTitle>
								<CardDescription
									data-limitreached={queueLength >= (maxQueueSize ?? Infinity)}
									className="data-[limitreached=true]:text-destructive"
								>
									{queueLength} / {maxQueueSize}
								</CardDescription>
							</span>
							<QueueControlPanel />
						</CardHeader>
						<CardContent className="p-0 px-1">
							<LayerList store={QD.LQStore} />
						</CardContent>
					</Card>
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
		_setPlayNextPopoverOpen(v)
	}

	const [appendLayersPopoverOpen, _setAppendLayersPopoverOpen] = React.useState(false)
	function setAppendLayersPopoverOpen(v: boolean) {
		_setAppendLayersPopoverOpen(v)
	}
	const canEdit = ZusUtils.useStoreDeep(QD.QDStore, (s) => s.canEditQueue, { dependencies: [] })

	const constraints = ZusUtils.useStoreDeep(QD.QDStore, state => QD.selectBaseQueryConstraints(state, state.poolApplyAs), {
		dependencies: [],
	})
	const queryInputs = {
		addtoQueue: { constraints },
		playNext: {
			constraints,
			cursor: LQY.getQueryCursorForQueueIndex(0),
		},
	} satisfies Record<string, LQY.LayerQueryBaseInput>

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
				title="Play After"
				selectQueueItems={(items) => QD.LQStore.getState().add(items)}
				open={appendLayersPopoverOpen}
				onOpenChange={setAppendLayersPopoverOpen}
				layerQueryBaseInput={queryInputs.addtoQueue}
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
				selectQueueItems={(items) => QD.LQStore.getState().add(items, { outerIndex: 0, innerIndex: null })}
				open={playNextPopoverOpen}
				onOpenChange={setPlayNextPopoverOpen}
				layerQueryBaseInput={queryInputs.playNext}
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
			case 'err:queue-too-large':
				toaster.toast({
					title: 'Queue too large',
					variant: 'destructive',
				})
				break
			case 'err:too-many-vote-choices':
			case 'err:not-enough-visible-info':
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
			<CardContent className="flex justify-between">
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
										{queueMutations.removed.size} items deleted
									</Badge>
								)}
								{queueMutations.moved.size > 0 && (
									<Badge variant="moved">
										{queueMutations.moved.size} items moved
									</Badge>
								)}
								{queueMutations.edited.size > 0 && (
									<Badge variant="edited">
										{queueMutations.edited.size} items edited
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

type PoolConfigurationPopoverHandle = {
	reset(settings: SS.ServerSettings): void
}
function PoolConfigurationPopover(
	props: {
		children: React.ReactNode
		ref?: React.ForwardedRef<PoolConfigurationPopoverHandle>
	},
) {
	const filterOptions = []
	for (const f of FilterEntityClient.useFilterEntities().values()) {
		filterOptions.push({
			value: f.id as string | null,
			label: f.name,
		})
	}
	filterOptions.push({ value: null, label: '<none>' })

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	React.useImperativeHandle(props.ref, () => ({
		reset: () => {},
	}))

	const [poolId, setPoolId] = React.useState<'mainPool' | 'generationPool'>('mainPool')
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
			s.editedServerState.settings.queue.mainPool.repeatRules,
			s.editedServerState.settings.queue.generationPool.repeatRules,
		],
		{ dependencies: [] },
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
		if (!settingsChanged) return
		QD.QDStore.getState().setSetting((settings) => {
			settings.queue.mainPool.repeatRules = [...mainPoolRules]
			settings.queue.generationPool.repeatRules = [...generationPoolRules]
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
							<Switch
								disabled={!canWriteSettings}
								id={applymainPoolSwitchId}
								checked={applyMainPool}
								onCheckedChange={setApplyMainPool}
							/>
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
				<PoolRepeatRulesConfigurationPanel
					className={poolId !== 'mainPool' ? 'hidden' : undefined}
					poolId="mainPool"
					rules={mainPoolRules}
					setRules={setMainPoolRules}
				/>
				<PoolRepeatRulesConfigurationPanel
					className={poolId !== 'generationPool' ? 'hidden' : undefined}
					poolId="generationPool"
					rules={generationPoolRules}
					setRules={setGenerationPoolRules}
				/>
				<Button
					disabled={!settingsChanged || !canWriteSettings}
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
}

function PoolFiltersConfigurationPanel({
	poolId,
}: {
	poolId: 'mainPool' | 'generationPool'
}) {
	const [filterIds, setSetting] = ZusUtils.useStoreDeep(QD.QDStore, (s) => [
		s.editedServerState.settings.queue[poolId].filters,
		s.setSetting,
	], { dependencies: [poolId] })

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	const add = (filterId: F.FilterEntityId | null) => {
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

function PoolRepeatRulesConfigurationPanel(props: {
	className?: string
	poolId: 'mainPool' | 'generationPool'
	rules: LQY.RepeatRule[]
	setRules: React.Dispatch<React.SetStateAction<LQY.RepeatRule[]>>
}) {
	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	return (
		<div className={cn('flex flex-col space-y-1 p-1 rounded', props.className)}>
			<div>
				<h4 className={Typography.H4}>Repeat Rules</h4>
			</div>
			{props.rules.map((rule, index) => {
				let targetValueOptions: string[]
				switch (rule.field) {
					case 'Map':
						targetValueOptions = L.StaticLayerComponents.maps
						break
					case 'Layer':
						targetValueOptions = L.StaticLayerComponents.layers
						break
					case 'Size':
						targetValueOptions = L.StaticLayerComponents.size
						break
					case 'Gamemode':
						targetValueOptions = L.StaticLayerComponents.gamemodes
						break
					case 'Faction':
						targetValueOptions = L.StaticLayerComponents.factions
						break
					case 'Alliance':
						targetValueOptions = L.StaticLayerComponents.alliances
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
							options={LQY.RepeatRuleFieldSchema.options}
							value={rule.field}
							allowEmpty={false}
							onSelect={(value) => {
								if (!value) return
								props.setRules(
									Im.produce((draft) => {
										draft[index].field = value as LQY.RepeatRuleField
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
		state => state.serverState ? LL.getNextLayerId(state.serverState?.layerQueue) : undefined,
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
	const layerStatusRes = SquadServerClient.useLayersStatus()
	const serverInfoRes = SquadServerClient.useServerInfoRes()
	const loggedInUser = useLoggedInUser()
	const hasDisableUpdatesPerm = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:disable-slm-updates'))
	const nextLayerDisplay = (layerStatusRes.code === 'ok' && layerStatusRes.data.nextLayer)
		? (
			<>
				Next Layer is set to: <b>{DH.displayUnvalidatedLayer(layerStatusRes.data.nextLayer)}</b>t
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
						<b>{serverInfoRes.code === 'ok' ? serverInfoRes.data.name : 'Squad Server'}</b>.
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

function PostGameBalanceTriggerAlert() {
	const currentMatch = SquadServerClient.useCurrentMatch()
	const allTriggerEvents = MatchHistoryClient.useMatchHistoryState().recentBalanceTriggerEvents
	if (!currentMatch || currentMatch.status !== 'post-game') return null
	const events = allTriggerEvents.filter(event => event.matchTriggeredId === currentMatch.historyEntryId)
		.sort((a, b) => BAL.getTriggerPriority(b.level) - BAL.getTriggerPriority(a.level))
	if (events.length === 0) return null
	const alerts = events.map(event => <BalanceTriggerAlert key={event.id} event={event} referenceMatch={currentMatch} />)
	if (alerts.length === 1) return alerts[0]
	return (
		<div className="flex flex-col space-y-1">
			{alerts[0]}
			<Accordion type="single" collapsible className="w-full">
				<AccordionItem value="additional-alerts">
					<AccordionTrigger className="py-2 text-sm">
						Show {alerts.length - 1} more
					</AccordionTrigger>
					<AccordionContent className="max-h-80 overflow-y-auto">
						<div className="flex flex-col space-y-2">
							{alerts.slice(1)}
						</div>
					</AccordionContent>
				</AccordionItem>
			</Accordion>
		</div>
	)
}
