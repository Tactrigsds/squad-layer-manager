import * as Icons from 'lucide-react'
import React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as DH from '@/lib/display-helpers.ts'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as DndKit from '@/systems/dndkit.client'
import * as LQYClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'

import { ConstraintEvalTooltip } from './constraint-matches-indicator.tsx'
import LayerContextMenuOptions from './layer-context-menu-options.tsx'
import ShortLayerName from './short-layer-name.tsx'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './ui/context-menu.tsx'

export default function LayerDisplay(props: {
	item: LQY.LayerItem
	badges?: React.ReactNode[]
	// rendered alongside the layer name, ahead of the badges, so tags read as part of the layer rather than as
	// another status indicator. addNote sits with them, and the group wraps under the name rather than breaking it.
	// The notes themselves go on a row of their own underneath
	tags?: React.ReactNode
	addNote?: React.ReactNode
	notes?: React.ReactNode
	backfillLayerId?: L.LayerId
	allowShowInfo?: boolean
	droppable?: boolean
	// data-tour for the layer name and for the indicator cluster, so the tour can point at either on the one row
	// it is narrating
	layerNameTourId?: string
	indicatorsTourId?: string
	// the name on a row of its own, everything else (tags, badges, `trailing`) on the row below: for a narrow
	// list, where a name and its indicators cannot share a line
	stacked?: boolean
	// rendered after the badges on the second row of a stacked display
	trailing?: React.ReactNode
	className?: string
	ref?: React.Ref<HTMLDivElement>
	// only available when rendered within a servers/$serverId context (e.g. teams/queue/match-history panels) -- omit
	// elsewhere (e.g. the filter editor) and queue-status badges/parity are simply not shown
	stores?: Partial<SquadServerFrame.KeyProp>
}) {
	const item = props.item
	const teamParity =
		Zus.useStore(props.stores?.squadServer, (s: SquadServerFrame.State | undefined) =>
			s ? LQY.getParityForLayerItem(s.layerItemsState, item) : 0,
		) ?? 0

	const statusData = LQYClient.useLayerItemStatusData(props.item, props.stores?.squadServer)
	const badges: React.ReactNode[] = []

	if (statusData) {
		badges.push(
			<ConstraintEvalTooltip
				key="constraint violation display"
				queriedConstraints={statusData.queriedConstraints}
				layerItem={props.item}
				matchDescriptors={statusData.matchingDescriptors}
				itemParity={teamParity}
				tourId={props.indicatorsTourId}
			/>,
		)
	}

	const dropItemCursors: LL.ItemRelativeCursor[] = []
	if (props.droppable && ['single-list-item', 'vote-list-item'].includes(props.item.type)) {
		dropItemCursors.push({ type: 'item-relative', itemId: props.item.itemId as string, position: 'on' })
	}

	const dropOnAttrs = DndKit.useDroppable(LL.llItemCursorsToDropItem(dropItemCursors))

	if (props.badges) badges.push(...props.badges)

	const layer = L.toLayer(props.item.layerId)
	if (!L.isKnownLayer(layer)) {
		badges.push(
			<Tooltip key="is unknown layer">
				<TooltipTrigger>
					<Icons.ShieldBan className="text-danger" />
				</TooltipTrigger>
				<TooltipContent>
					<p>
						{tr.text(L_Msgs.unparsedLayer())} (<b>{DH.displayLayer(layer)}</b>)
					</p>
				</TooltipContent>
			</Tooltip>,
		)
	} else if (statusData && !statusData.present.has(L.normalize(props.item.layerId))) {
		badges.push(
			<Tooltip key="layer doesn't exist">
				<TooltipTrigger>
					<Icons.ShieldOff className="text-danger" />
				</TooltipTrigger>
				<TooltipContent>
					<b>{tr.text(L_Msgs.unknownLayer())}</b>
				</TooltipContent>
			</Tooltip>,
		)
	}

	return (
		<ContextMenu modal={false}>
			<ContextMenuTrigger
				asChild
				// the queue item this sits inside has its own menu -- right-clicking the layer is about the layer
				onContextMenu={(e: React.MouseEvent) => e.stopPropagation()}
			>
				<div className={cn('flex flex-col gap-0.5', props.className)} ref={props.ref}>
					{props.stacked ? (
						<>
							<ShortLayerName
								tourId={props.layerNameTourId}
								ref={(props.droppable && dropOnAttrs.ref) || undefined}
								className={cn('min-w-0 [&>*]:whitespace-nowrap', dropOnAttrs.isDropTarget && 'bg-secondary')}
								layerId={props.item.layerId}
								teamParity={teamParity}
								backfillLayerId={props.backfillLayerId}
								matchDescriptors={statusData?.highlightedMatchDescriptors}
								allowShowInfo={props.allowShowInfo}
							/>
							{(props.tags || props.addNote || badges.length > 0 || props.trailing) && (
								<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
									{props.tags}
									{props.addNote}
									{badges.length > 0 && <span className="flex items-center gap-1">{badges}</span>}
									{props.trailing}
								</div>
							)}
						</>
					) : (
						<div className="flex space-x-2 items-center">
							<span
								data-over={(props.droppable && dropOnAttrs.isDropTarget) || undefined}
								className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0"
							>
								<ShortLayerName
									tourId={props.layerNameTourId}
									ref={(props.droppable && dropOnAttrs.ref) || undefined}
									className={cn('flex-nowrap shrink-0 whitespace-nowrap', dropOnAttrs.isDropTarget && 'bg-secondary')}
									layerId={props.item.layerId}
									teamParity={teamParity}
									backfillLayerId={props.backfillLayerId}
									matchDescriptors={statusData?.highlightedMatchDescriptors}
									allowShowInfo={props.allowShowInfo}
								/>
								{(props.tags || props.addNote) && (
									<span className="flex items-center gap-2">
										{props.tags}
										{props.addNote}
									</span>
								)}
							</span>
							<span className="flex items-center gap-1">{badges}</span>
						</div>
					)}
					{props.notes}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<LayerContextMenuOptions layerIds={[props.item.layerId]} />
			</ContextMenuContent>
		</ContextMenu>
	)
}
