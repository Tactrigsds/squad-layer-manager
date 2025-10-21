import MatchHistoryPanel from '@/components/match-history-panel.tsx'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { TeamIndicator } from '@/lib/display-helpers-teams.tsx'
import * as DH from '@/lib/display-helpers.ts'
import { hasMutations } from '@/lib/item-mutations.ts'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as BAL from '@/models/balance-triggers.models'
import * as F from '@/models/filter.models.ts'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import * as RBAC from '@/rbac.models'
import { useConfig } from '@/systems.client/config.client.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import * as SLLClient from '@/systems.client/shared-layer-list.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import { trpc } from '@/trpc.client.ts'
import { useMutation } from '@tanstack/react-query'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import BalanceTriggerAlert from './balance-trigger-alert.tsx'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import CurrentLayerCard from './current-layer-card.tsx'
import FilterEntitySelect from './filter-entity-select.tsx'
import { LayerList } from './layer-list.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { ServerUnreachable } from './server-offline-display.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Separator } from './ui/separator.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'
import UserPresencePanel from './user-presence-panel.tsx'

export default function LayerQueueDashboard() {
	const serverStatusRes = SquadServerClient.useServerInfoRes()

	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)

	const queueLength = Zus.useStore(QD.LQStore, (s) => s.layerList.length)
	const maxQueueSize = useConfig()?.layerQueue.maxQueueSize
	const updatesToSquadServerDisabled = Zus.useStore(ServerSettingsClient.Store, s => s.saved.updatesToSquadServerDisabled)
	type Tab = 'history' | 'queue'
	const [activeTab, setActiveTab] = React.useState<Tab>('queue')
	const queueMutations = Zus.useStore(QD.LQStore, (s) => s.session.mutations)

	return (
		<div className="mx-auto grid place-items-center">
			{/* Mobile/Tablet: Show tabs */}
			<div className="w-full flex flex-wrap justify-between items-center pb-2 dash-2col:hidden">
				<span className="flex items-center">
					<TabsList
						active={activeTab}
						options={[{ label: 'History', value: 'history' }, { label: 'Queue', value: 'queue' }]}
						setActive={setActiveTab}
					/>
					<NormTeamsSwitch />
				</span>
				<UserPresencePanel />
			</div>
			{/* Desktop: Show only NormTeamsSwitch */}
			<div className="w-full justify-between pb-2 hidden dash-2col:flex">
				<NormTeamsSwitch />
				<UserPresencePanel />
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
					{updatesToSquadServerDisabled && <SyncToSquadServerDisabledAlert />}
					<PostGameBalanceTriggerAlert />
					{/*{isModified && <EditingCard />}*/}
					<Card>
						<CardHeader className="flex flex-row items-center justify-between">
							<span className="flex items-center space-x-1">
								<CardTitle>Up Next</CardTitle>
								{isModified && (
									<CardDescription
										data-limitreached={queueLength >= (maxQueueSize ?? Infinity)}
										className=" pl-1 data-[limitreached=true]:text-destructive"
									>
										{queueLength} / {maxQueueSize}
									</CardDescription>
								)}
							</span>
							<QueueControlPanel />
						</CardHeader>
						{queueMutations.removed.size > 0 && (
							<Alert variant="destructive">
								{queueMutations.removed.size} item{queueMutations.removed.size === 1 ? '' : 's'} removed
							</Alert>
						)}
						<CardContent className="p-0 px-1">
							<LayerList store={SLLClient.Store} />
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
	const [appendLayersPopoverOpen, _setAppendLayersPopoverOpen] = SLLClient.useActivityState({ code: 'adding-item' })
	function setAppendLayersPopoverOpen(v: boolean) {
		_setAppendLayersPopoverOpen(v)
	}
	const [isModified, saving, queueLength] = Zus.useStore(SLLClient.Store, useShallow(s => [s.isModified, s.saving, s.layerList.length]))

	type AddLayersPosition = 'next' | 'after'
	const [addLayersPosition, setAddLayersPosition] = React.useState<AddLayersPosition>('next')

	async function saveLqState() {
		await SLLClient.Store.getState().save()
	}

	function clear() {
		const state = QD.LQStore.getState()
		// we don't have to include children here
		const itemIds = state.layerList.map(item => item.itemId)
		state.dispatch({ op: 'clear', itemIds })
	}

	const addItems = React.useMemo(() => {
		return (items: LL.NewLayerListItem[]) => {
			const state = QD.LQStore.getState()
			const index: LL.ItemIndex = addLayersPosition === 'next'
				? { innerIndex: null, outerIndex: 0 }
				: { innerIndex: null, outerIndex: queueLength }
			state.dispatch({ op: 'add', items, index })
		}
	}, [addLayersPosition, queueLength])

	const addLayersTabslist = (
		<TabsList
			options={[
				{ label: 'Play Next', value: 'next' },
				{ label: 'Play After', value: 'after' },
			]}
			active={addLayersPosition}
			setActive={setAddLayersPosition}
		/>
	)

	const queryInputs = {
		next: {
			cursor: LQY.getQueryCursorForQueueIndex(0),
		},
		after: {},
	} satisfies Record<AddLayersPosition, LQY.LayerQueryBaseInput>

	return (
		<div className="flex items-center space-x-1">
			{isModified && (
				<>
					<div className="space-x-1 flex items-center">
						<Icons.LoaderCircle
							className="animate-spin data-[pending=false]:invisible"
							data-pending={saving}
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									onClick={saveLqState}
									disabled={saving}
								>
									<Icons.Save />
									<span>Save</span>
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								<p>Save</p>
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button size="icon" disabled={saving} onClick={() => SLLClient.Store.getState().reset()} variant="secondary">
									<Icons.Undo />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								<p>Reset</p>
							</TooltipContent>
						</Tooltip>
					</div>
					<Separator orientation="vertical" />
				</>
			)}
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="icon"
						onClick={() => clear()}
					>
						<Icons.Trash />
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<p>Clear Queue</p>
				</TooltipContent>
			</Tooltip>
			<SelectLayersDialog
				title="Add Layers"
				headerAdditions={addLayersTabslist}
				selectQueueItems={addItems}
				open={appendLayersPopoverOpen}
				onOpenChange={setAppendLayersPopoverOpen}
				layerQueryBaseInput={queryInputs[addLayersPosition]}
			>
				<Button className="flex w-min items-center space-x-0">
					<Icons.PlusIcon />
					<span>Add Layers</span>
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

type PoolConfigurationPopoverHandle = {
	reset(settings: SS.ServerSettings): void
}
function PoolConfigurationPopover(
	props: {
		children: React.ReactNode
		ref?: React.ForwardedRef<PoolConfigurationPopoverHandle>
	},
) {
	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	React.useImperativeHandle(props.ref, () => ({
		reset: () => {},
	}))

	const [poolId, setPoolId] = React.useState<'mainPool' | 'generationPool'>('mainPool')

	const [open, _setOpen] = SLLClient.useActivityState({ code: 'changing-settings' })
	const setOpen = (open: boolean) => {
		if (!open) {
			ServerSettingsClient.Store.getState().reset()
		}
		_setOpen(open)
	}

	const [applyMainPool, settingsChanged] = Zus.useStore(
		ServerSettingsClient.Store,
		useShallow(s => [s.saved.queue.applyMainPoolToGenerationPool, s.modified]),
	)
	const applymainPoolSwitchId = React.useId()

	function setApplyMainPool(checked: boolean | 'indeterminate') {
		if (checked === 'indeterminate') return
		ServerSettingsClient.Store.getState().set({ path: ['queue', 'applyMainPoolToGenerationPool'], value: checked })
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
				/>
				<PoolRepeatRulesConfigurationPanel
					className={poolId !== 'generationPool' ? 'hidden' : undefined}
					poolId="generationPool"
				/>
				<Button
					disabled={!settingsChanged}
					onClick={() => {
						saveRules()
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
	const filterPath = ['queue', poolId, 'filters']
	const filterIds = Zus.useStore(ServerSettingsClient.Store, (s) => SS.derefSettingsValue(s.edited, filterPath) as string[])

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const state = ServerSettingsClient.Store.getState()
		const newFilters = [...filterIds, filterId]
		state.set({ path: filterPath, value: newFilters })
	}

	return (
		<div>
			<div>
				<h4 className={Typography.H4}>Filters</h4>
			</div>
			<ul>
				{filterIds.map((filterId, i) => {
					const path = [...filterPath, i]
					const onSelect = (newFilterId: string | null) => {
						if (newFilterId === null) {
							return
						}
						const state = ServerSettingsClient.Store.getState()
						state.set({ path: path, value: newFilterId })
					}
					const deleteFilter = () => {
						const state = ServerSettingsClient.Store.getState()
						const filterIds = Obj.deepClone(SS.derefSettingsValue(state.edited, path) as string[])
						filterIds.splice(i, 1)
						state.set({ path: path, value: filterIds })
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
}) {
	const rulesPath = React.useMemo(() => ['queue', props.poolId, 'repeatRules'], [props.poolId])
	const selectRules = React.useCallback(
		(s: ServerSettingsClient.EditSettingsStore) => SS.derefSettingsValue(s.edited, rulesPath) as LQY.RepeatRule[],
		[rulesPath],
	)

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))
	const rules = Zus.useStore(ServerSettingsClient.Store, selectRules)

	const setRules = React.useCallback((update: React.SetStateAction<LQY.RepeatRule[]>) => {
		const state = ServerSettingsClient.Store.getState()
		const updated = typeof update === 'function' ? update(selectRules(state)) : update
		state.set({ path: rulesPath, value: updated })
	}, [rulesPath, selectRules])

	return (
		<div className={cn('flex flex-col space-y-1 p-1 rounded', props.className)}>
			<div>
				<h4 className={Typography.H4}>Repeat Rules</h4>
			</div>
			{rules.map((rule, index) => {
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
								setRules(
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
								setRules(
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
								setRules(
									Im.produce((draft) => {
										draft[index].within = Math.floor(Number(e.target.value))
									}),
								)
							}}
						/>
						<ComboBoxMulti
							className="flex-grow"
							title="Target"
							options={targetValueOptions}
							disabled={!canWriteSettings}
							values={rule.targetValues ?? []}
							onSelect={(updated) => {
								setRules(
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
								setRules(
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
					setRules(
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

function SyncToSquadServerDisabledAlert() {
	const { enableUpdates } = QD.useToggleSquadServerUpdates()
	const layerStatusRes = SquadServerClient.useLayersStatus()
	const serverInfoRes = SquadServerClient.useServerInfoRes()
	const loggedInUser = useLoggedInUser()
	const hasDisableUpdatesPerm = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:disable-slm-updates'))
	const nextLayerDisplay = (layerStatusRes.code === 'ok' && layerStatusRes.data.nextLayer)
		? (
			<>
				Next Layer is set to: <b>{DH.displayLayer(layerStatusRes.data.nextLayer)}</b>t
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
