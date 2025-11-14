import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as DH from '@/lib/display-helpers.ts'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers.ts'
import { cn } from '@/lib/utils.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as LQYClient from '@/systems.client/layer-queries.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import { ConstraintDisplay } from './constraint-display.tsx'
import ShortLayerName from './short-layer-name.tsx'

export default function LayerDisplay(
	props: {
		item: LQY.LayerItem
		badges?: React.ReactNode[]
		backfillLayerId?: L.LayerId
		allowShowInfo?: boolean
		className?: string
		ref?: React.Ref<HTMLDivElement>
	},
) {
	const layerItemId = LQY.toSerial(props.item)
	const teamParity = ReactRxHelpers.useStateObservableSelection(
		QD.layerItemsState$,
		React.useCallback((context) => LQY.getParityForLayerItem(context, props.item), [props.item]),
	) ?? 0

	const statusData = LQYClient.useLayerItemStatusDataForItem(layerItemId)
	const badges: React.ReactNode[] = []

	if (statusData.matchingConstraints) {
		badges.push(
			<ConstraintDisplay
				key="constraint violation display"
				matchingConstraints={statusData.matchingConstraints}
				layerItemId={layerItemId}
			/>,
		)
	}

	if (props.badges) badges.push(...props.badges)

	const layer = L.toLayer(props.item.layerId)
	if (!L.isKnownLayer(layer)) {
		badges.push(
			<Tooltip key="is unknown layer">
				<TooltipTrigger>
					<Icons.ShieldOff className="text-red-500" />
				</TooltipTrigger>
				<TooltipContent>
					<p>
						This layer is unknown and was not able to be fully parsed: (<b>{DH.displayLayer(layer)}</b>)
					</p>
				</TooltipContent>
			</Tooltip>,
		)
	} else if (statusData.present && !statusData.present?.has(L.normalize(props.item.layerId))) {
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
			<span className="flex-1 text-nowrap">
				<ShortLayerName
					layerId={props.item.layerId}
					teamParity={teamParity}
					backfillLayerId={props.backfillLayerId}
					matchDescriptors={statusData.highlightedMatchDescriptors}
					allowShowInfo={props.allowShowInfo}
				/>
			</span>
			<span className="flex items-center space-x-1">
				{badges}
			</span>
		</div>
	)
}
