import MatchHistoryPanel from '@/components/match-history-panel.tsx'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { TeamIndicator } from '@/lib/display-helpers-teams.tsx'
import * as DH from '@/lib/display-helpers.ts'
import * as ST from '@/lib/state-tree.ts'
import * as BAL from '@/models/balance-triggers.models'
import * as SLL from '@/models/shared-layer-list'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import * as SLLClient from '@/systems.client/shared-layer-list.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import BalanceTriggerAlert from './balance-trigger-alert.tsx'
import CurrentLayerCard from './current-layer-card.tsx'
import { LayerList, StartActivityInteraction } from './layer-list.tsx'
import { ServerUnreachable } from './server-offline-display.tsx'
import PoolConfigurationPopover from './server-settings-popover.tsx'
import { Label } from './ui/label.tsx'
import { Separator } from './ui/separator.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'
import UserPresencePanel from './user-presence-panel.tsx'

export default function LayerQueueDashboard() {
	const serverStatusRes = SquadServerClient.useServerInfoRes()

	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)

	const queueLength = Zus.useStore(QD.LQStore, (s) => s.layerList.length)
	const maxQueueSize = ConfigClient.useConfig()?.layerQueue.maxQueueSize
	const updatesToSquadServerDisabled = Zus.useStore(ServerSettingsClient.Store, s => s.saved.updatesToSquadServerDisabled)
	type Tab = 'history' | 'queue'
	const [activeTab, setActiveTab] = React.useState<Tab>('queue')
	const queueMutations = Zus.useStore(QD.LQStore, (s) => s.session.mutations)

	const [isEditing, setEditing] = SLLClient.useActivityState(SLL.TOGGLE_EDITING_TRANSITIONS)

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
					<Card>
						<CardHeader className="flex flex-row items-center justify-between">
							<span className="flex items-center space-x-1">
								<CardTitle>Up Next</CardTitle>
								{
									/*<Toggle
									pressed={isEditing}
									onPressedChange={setEditing}
									aria-label="Toggle bookmark"
									size="sm"
								>
									{isEditing
										? (
											<>
												<Icons.Check className="ml-1" />
												<span>Finished</span>
											</>
										)
										: (
											<>
												<Icons.Edit className="ml-1" />
												<span>Start Editing</span>
											</>
										)}
								</Toggle>*/
								}
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
	const [isEditing, setEditing] = SLLClient.useActivityState({
		matchActivity: React.useCallback((root) => !!root.child?.EDITING, []),
		createActivity: Im.produce((root: Im.WritableDraft<SLL.RootActivity>) => {
			root.child.EDITING ??= {
				_tag: 'variant',
				id: 'EDITING',
				opts: {},
				chosen: ST.Match.leaf('IDLE', {}),
			}
		}),
		removeActivity: Im.produce((root: Im.WritableDraft<SLL.RootActivity>) => {
			delete root.child.EDITING
		}),
	})

	const [isModified, saving] = Zus.useStore(
		SLLClient.Store,
		useShallow(s => [s.isModified, s.saving]),
	)

	async function saveLqState() {
		await SLLClient.Store.getState().save()
	}

	function clear() {
		const state = QD.LQStore.getState()
		// we don't have to include children here
		const itemIds = state.layerList.map(item => item.itemId)
		void state.dispatch({ op: 'clear', itemIds })
	}

	return (
		<div className="flex justify-between items-center">
			<div className="flex items-center space-x-1 flex-grow">
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
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={SLL.createEditActivityVariant({
						_tag: 'leaf',
						id: 'ADDING_ITEM',
						opts: { cursor: { type: 'start' }, variant: 'toggle-position' },
					})}
					matchKey={key => key.id === 'ADDING_ITEM' && key.opts.variant === 'toggle-position'}
					preload="render"
					render={Button}
					className="flex w-min items-center space-x-0"
				>
					<Icons.PlusIcon />
					<span>Add Layers</span>
				</StartActivityInteraction>
				<PoolConfigurationPopover>
					<Button size="icon" variant="ghost" title="Pool Configuration">
						<Icons.Settings />
					</Button>
				</PoolConfigurationPopover>
			</div>
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
