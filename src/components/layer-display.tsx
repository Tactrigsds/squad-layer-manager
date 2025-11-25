import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as DH from '@/lib/display-helpers.ts'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers.ts'
import { cn } from '@/lib/utils.ts'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as DndKit from '@/systems.client/dndkit.ts'
import * as LQYClient from '@/systems.client/layer-queries.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import { ConstraintMatchesIndicator } from './constraint-matches-indicator.tsx'
import ShortLayerName from './short-layer-name.tsx'

export default function LayerDisplay(
	props: {
		item: LQY.LayerItem
		badges?: React.ReactNode[]
		backfillLayerId?: L.LayerId
		allowShowInfo?: boolean
		droppable?: boolean
		className?: string
		ref?: React.Ref<HTMLDivElement>
	},
) {
	const teamParity = ReactRxHelpers.useStateObservableSelection(
		QD.layerItemsState$,
		React.useCallback((context) => LQY.getParityForLayerItem(context, props.item), [props.item]),
	) ?? 0

	const statusData = LQYClient.useLayerItemStatusData(props.item)
	const badges: React.ReactNode[] = []

	if (statusData) {
		badges.push(
			<ConstraintMatchesIndicator
				key="constraint violation display"
				queriedConstraints={statusData.queriedConstraints}
				matchingConstraintIds={statusData.matchingConstraintIds}
				itemId={LQY.resolveId(props.item)}
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
					<Icons.ShieldBan className="text-red-800" />
				</TooltipTrigger>
				<TooltipContent>
					<p>
						This layer is unknown and was not able to be fully parsed: (<b>{DH.displayLayer(layer)}</b>)
					</p>
				</TooltipContent>
			</Tooltip>,
		)
	} else if (statusData && !statusData.present.has(L.normalize(props.item.layerId))) {
		badges.push(
			<Tooltip key="layer doesn't exist">
				<TooltipTrigger>
					<Icons.ShieldOff className="text-red-500" />
				</TooltipTrigger>
				<TooltipContent>
					<b>Layer is unknown</b>
				</TooltipContent>
			</Tooltip>,
		)
	}

	return (
		<div className={cn('flex space-x-2 items-center', props.className)} ref={props.ref}>
			<span
				data-over={props.droppable && dropOnAttrs.isDropTarget || undefined}
				className="flex-1 text-nowrap"
			>
				<ShortLayerName
					ref={props.droppable && dropOnAttrs.ref || undefined}
					className={dropOnAttrs.isDropTarget ? 'bg-secondary' : undefined}
					layerId={props.item.layerId}
					teamParity={teamParity}
					backfillLayerId={props.backfillLayerId}
					matchDescriptors={statusData?.highlightedMatchDescriptors}
					allowShowInfo={props.allowShowInfo}
				/>
			</span>
			<span className="flex items-center space-x-1">
				{badges}
			</span>
		</div>
	)
}
