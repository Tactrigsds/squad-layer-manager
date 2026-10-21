import * as Icons from 'lucide-react'
import React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import type * as ListHostPrt from '@/frame-partials/list-host.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import * as DH from '@/models/display-helpers.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as L from '@/models/layer.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'

import { ConstraintEvalTooltip } from './constraint-matches-indicator.tsx'
import ShortLayerName from './short-layer-name.tsx'

export default function LayerDisplay({
	ref,
	...props
}: {
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
	indicatorsClassName?: string
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
	// the list the layer is shown in: a server's queue (the squad server frame is a list host) or a rotation. Omit it
	// elsewhere (e.g. the filter editor) and queue-status badges/parity are simply not shown
	stores?: Partial<ListHostPrt.KeyProp & SquadServerFrame.KeyProp>
}) {
	const item = props.item
	const listHost: ListHostPrt.Key | undefined = props.stores?.listHost ?? props.stores?.squadServer
	const teamParity =
		Zus.useStore(listHost, (s: ListHostPrt.Store | undefined) => (s ? LQY.getParityForLayerItem(s.layerItemsState, item) : 0)) ?? 0

	const statusData = LayerQueriesClient.useLayerItemStatusData(props.item, listHost)
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
		<div className={cn('flex flex-col gap-0.5', props.className)} ref={ref}>
			{props.stacked ? (
				<>
					<ShortLayerName
						tourId={props.layerNameTourId}
						className="min-w-0 [&>*]:whitespace-nowrap"
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
							{badges.length > 0 && <span className={cn('flex items-center gap-1', props.indicatorsClassName)}>{badges}</span>}
							{props.trailing}
						</div>
					)}
				</>
			) : (
				<div className="flex space-x-2 items-center">
					<span className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
						<ShortLayerName
							tourId={props.layerNameTourId}
							className="flex-nowrap shrink-0 whitespace-nowrap"
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
					<span className={cn('flex items-center gap-1', props.indicatorsClassName)}>{badges}</span>
				</div>
			)}
			{props.notes}
		</div>
	)
}
