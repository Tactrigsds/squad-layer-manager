import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CardDescription } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as ST from '@/lib/state-tree.ts'
import * as SLL from '@/models/shared-layer-list'
import * as ConfigClient from '@/systems/config.client'
import * as QD from '@/systems/queue-dashboard.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { LayerList, StartActivityInteraction } from './layer-list.tsx'
import { MatchHistoryPanelContent } from './match-history-panel'
import PoolConfigurationPopover from './server-settings-popover.tsx'
import UserPresencePanel from './user-presence-panel'

export default function LayersPanel() {
	return (
		<Card className="flex flex-col flex-1 min-h-0">
			<ScrollArea className="flex-1">
				<MatchHistoryPanelContent />
				<Separator />
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle>Recent Users</CardTitle>
					<UserPresencePanel />
				</CardHeader>
				<Separator />
				<QueuePanelContent />
			</ScrollArea>
		</Card>
	)
}

function QueueControlPanel() {
	const isEditing = SLLClient.useIsEditing()
	const setEditing = (editing: boolean) => {
		SLLClient.Store.getState().dispatch({ op: editing ? 'start-editing' : 'finish-editing' })
	}

	const [isModified, committing] = Zus.useStore(
		SLLClient.Store,
		useShallow(s => [s.isModified, s.committing]),
	)
	const numEditors = Zus.useStore(SLLClient.Store, useShallow(s => s.session.editors.size))

	function clear() {
		const state = QD.LQStore.getState()
		// we don't have to include children here
		const itemIds = state.layerList.map(item => item.itemId)
		void state.dispatch({ op: 'clear', itemIds })
	}

	return (
		<div className="flex items-center space-x-1 grow justify-end">
			<div className="space-x-1 flex items-center">
				<Icons.LoaderCircle
					className="animate-spin data-[pending=false]:invisible"
					data-pending={committing}
				/>
				{isEditing && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="icon"
								disabled={!isModified}
								onClick={() => SLLClient.Store.getState().reset()}
								variant="secondary"
							>
								<Icons.Undo />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Reset</p>
						</TooltipContent>
					</Tooltip>
				)}
				{!isEditing && (
					<Button variant="outline" onClick={() => setEditing(true)}>
						<Icons.Edit />
						<span>Start Editing</span>
					</Button>
				)}
				{(isEditing || committing)
					&& (
						<Button
							onClick={() => setEditing(false)}
							disabled={committing}
						>
							{isModified && numEditors === 1 ? <Icons.Save /> : <Icons.Check />}
							<span>{isModified && numEditors === 1 ? 'Save' : 'Finish Editing'}</span>
						</Button>
					)}
			</div>
			<Separator orientation="vertical" />
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						disabled={!isEditing}
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
					opts: { cursor: { type: 'start' }, variant: 'toggle-position', action: 'add' },
				})}
				matchKey={key => key.id === 'ADDING_ITEM' && key.opts.variant === 'toggle-position'}
				preload="intent"
				render={Button}
				className="flex w-min items-center space-x-0"
				disabled={!isEditing}
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
