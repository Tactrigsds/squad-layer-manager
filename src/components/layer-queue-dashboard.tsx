import MatchHistoryPanel from '@/components/match-history-panel.tsx'
import ServerChatPanel from '@/components/server-chat-panel.tsx'
import ServerStatsPanel from '@/components/server-stats-panel.tsx'
import { TeamIndicator } from '@/components/teams-display.tsx'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as DH from '@/lib/display-helpers.ts'
import * as ST from '@/lib/state-tree.ts'
import * as BAL from '@/models/balance-triggers.models'
import * as SLL from '@/models/shared-layer-list'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
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
import PoolConfigurationPopover from './server-settings-popover.tsx'
import { Label } from './ui/label.tsx'
import { Separator } from './ui/separator.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'
import UserPresencePanel from './user-presence-panel.tsx'

export default function LayerQueueDashboard() {
	return (
		<div className="mx-auto grid place-items-center">
			<div className="grid grid-cols-[auto,auto] gap-2">
				{/* Desktop: Show only NormTeamsSwitch */}
				<div className="col-span-2 justify-between flex">
					<NormTeamsSwitch />
					<UserPresencePanel />
				</div>
				{/* left column */}
				<div className="flex flex-col gap-2">
					<MatchHistoryPanel />
					<CurrentLayerCard />
					<QueuePanel />
				</div>
				{/* right column */}
				<div className="flex flex-col gap-2">
					{/*<ServerStatsPanel />*/}
					<ServerChatPanel />
				</div>
			</div>
		</div>
	)
}

function QueuePanel() {
	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)

	const queueLength = Zus.useStore(QD.LQStore, (s) => s.layerList.length)
	const maxQueueSize = ConfigClient.useConfig()?.layerQueue.maxQueueSize
	const queueMutations = Zus.useStore(QD.LQStore, (s) => s.session.mutations)

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between">
				<span className="flex items-center space-x-1 w-full">
					<span className="flex flex-col gap-0.5">
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
									className=" pl-1 data-[limitreached=true]:text-destructive flex gap-1 items-center"
								>
									<span>
										{queueLength} / {maxQueueSize}
									</span>
								</CardDescription>
							)}
						</span>
						<span className="flex gap-1">
							{[
								{ variant: 'added', size: queueMutations.added.size, label: 'added' },
								{ variant: 'edited', size: queueMutations.edited.size, label: 'edited' },
								{ variant: 'moved', size: queueMutations.moved.size, label: 'moved' },
								{ variant: 'destructive', size: queueMutations.removed.size, label: 'removed' },
							]
								.sort((a, b) => (b.size > 0 ? 1 : 0) - (a.size > 0 ? 1 : 0))
								.map((item) => (
									<Badge
										key={item.label}
										variant={item.variant as 'added' | 'edited' | 'moved' | 'destructive'}
										data-visible={item.size > 0}
										className="data-[visible=false]:invisible font-mono font-semibold tracking-tight"
									>
										{item.size} {item.label}
									</Badge>
								))}
						</span>
					</span>
					<QueueControlPanel />
				</span>
			</CardHeader>
			<CardContent className="p-0 px-1">
				<LayerList store={SLLClient.Store} />
			</CardContent>
		</Card>
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
		<div className="flex items-center space-x-1 flex-grow justify-end">
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
	)
}
