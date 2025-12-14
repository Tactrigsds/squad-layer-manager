import CombinedDashboardPanel from '@/components/combined-dashboard-panel.tsx'
import ServerActivityPanel from '@/components/server-activity-panel.tsx'

import { TeamIndicator } from '@/components/teams-display.tsx'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

import * as ST from '@/lib/state-tree.ts'

import * as SLL from '@/models/shared-layer-list'

import * as ConfigClient from '@/systems.client/config.client.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'

import * as SLLClient from '@/systems.client/shared-layer-list.client.ts'

import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { LayerList, StartActivityInteraction } from './layer-list.tsx'
import { ServerActionsDropdown } from './server-actions-dropdown.tsx'
import PoolConfigurationPopover from './server-settings-popover.tsx'
import { Label } from './ui/label.tsx'
import { Separator } from './ui/separator.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'
import UserPresencePanel from './user-presence-panel.tsx'

export default function LayerQueueDashboard() {
	const [activeTab, setActiveTab] = React.useState<'layers' | 'server-activity'>('layers')
	const [isDesktop, setIsDesktop] = React.useState(false)

	React.useEffect(() => {
		const mediaQuery = window.matchMedia('(min-width: 1280px)')
		setIsDesktop(mediaQuery.matches)

		const handleChange = (e: MediaQueryListEvent) => {
			setIsDesktop(e.matches)
		}

		mediaQuery.addEventListener('change', handleChange)
		return () => mediaQuery.removeEventListener('change', handleChange)
	}, [])

	return (
		<div className="mx-auto grid place-items-center">
			{!isDesktop && (
				/* Mobile/tablet: Single column with tabs */
				<div className="flex flex-col gap-2">
					{/* Top line - always visible */}
					<div className="justify-between flex items-center">
						<div className="flex items-center gap-2">
							<TabsList
								options={[
									{ value: 'layers', label: 'Layers' },
									{ value: 'server-activity', label: 'Server Activity' },
								]}
								active={activeTab}
								setActive={setActiveTab}
							/>
							<NormTeamsSwitch />
						</div>
						<ServerActionsDropdown />
					</div>

					<div style={{ visibility: activeTab === 'layers' ? 'visible' : 'hidden', height: activeTab === 'layers' ? 'auto' : '0' }}>
						<CombinedDashboardPanel />
					</div>
					<div
						style={{
							visibility: activeTab === 'server-activity' ? 'visible' : 'hidden',
							height: activeTab === 'server-activity' ? 'auto' : '0',
						}}
					>
						<ServerActivityPanel />
					</div>
				</div>
			)}

			{isDesktop && (
				/* Desktop: Two column layout */
				<div className="grid grid-cols-[auto,auto] gap-2">
					{/* Top line */}
					<div className="col-span-2 justify-between flex">
						<NormTeamsSwitch />
						<ServerActionsDropdown />
					</div>
					{/* left column */}
					<div className="flex flex-col gap-2">
						<CombinedDashboardPanel />
					</div>
					{/* right column */}
					<div className="flex gap-2">
						<ServerActivityPanel />
					</div>
				</div>
			)}
		</div>
	)
}

export function QueuePanelContent() {
	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)

	const queueLength = Zus.useStore(QD.LQStore, (s) => s.layerList.length)
	const maxQueueSize = ConfigClient.useConfig()?.layerQueue.maxQueueSize
	const queueMutations = Zus.useStore(QD.LQStore, (s) => s.session.mutations)

	return (
		<>
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
								{ variant: 'added', size: queueMutations.added.size, label: 'added', icon: Icons.Plus },
								{ variant: 'edited', size: queueMutations.edited.size, label: 'edited', icon: Icons.Pencil },
								{ variant: 'moved', size: queueMutations.moved.size, label: 'moved', icon: Icons.ArrowUpDown },
								{ variant: 'destructive', size: queueMutations.removed.size, label: 'removed', icon: Icons.Trash },
							]
								.sort((a, b) => (b.size > 0 ? 1 : 0) - (a.size > 0 ? 1 : 0))
								.map((item) => (
									<Badge
										key={item.label}
										variant={item.variant as 'added' | 'edited' | 'moved' | 'destructive'}
										data-visible={item.size > 0}
										className="data-[visible=false]:invisible font-mono font-semibold tracking-tight flex items-center gap-1"
										title={`${item.size} ${item.label}`}
									>
										<item.icon className="h-3 w-3" />
										{item.size}
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
		</>
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
							(left: <TeamIndicator team="A" /> right: <TeamIndicator team="B" />)
						</span>
					)
					: (
						<span>
							(left: <TeamIndicator team={1} /> right: <TeamIndicator team={2} />)
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
				preload="intent"
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
