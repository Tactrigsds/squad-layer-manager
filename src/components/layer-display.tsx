import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useLayerStatuses } from '@/hooks/use-layer-queries.ts'
import * as DH from '@/lib/display-helpers'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import { ConstraintViolationDisplay } from './constraint-violation-display.tsx'

export default function LayerDisplay(props: { layerId: M.LayerId; itemId: string; isVoteChoice?: boolean; badges?: React.ReactNode[] }) {
	const layerStatusesRes = useLayerStatuses()
	const badges: React.ReactNode[] = []
	const constraints = ZusUtils.useStoreDeep(QD.QDStore, s => M.getPoolConstraints(s.editedServerState.settings.queue.mainPool))
	if (props.badges) badges.push(...props.badges)

	if (layerStatusesRes.data) {
		const exists = layerStatusesRes.data.present.has(props.layerId)
		if (!exists) {
			badges.push(
				<Tooltip key="layer doesn't exist">
					<TooltipTrigger>
						<Icons.ShieldQuestion className="text-orange-400" />
					</TooltipTrigger>
					<TooltipContent>
						<b>Layer is unknown</b>
					</TooltipContent>
				</Tooltip>,
			)
		}

		const blockingConstraintIds = layerStatusesRes.data?.blocked.get(
			M.toQueueLayerKey(props.itemId, props.isVoteChoice ? props.layerId : undefined),
		)
		if (blockingConstraintIds) {
			badges.push(
				<ConstraintViolationDisplay
					key="constraint violation display"
					violated={Array.from(blockingConstraintIds).map(id => constraints.find(c => c.id === id)!)}
					violationDescriptors={layerStatusesRes.data?.violationDescriptors.get(props.itemId)}
					layerId={props.layerId}
				/>,
			)
		}
	}
	if (M.isRawLayerId(props.layerId)) {
		badges.push(
			<Tooltip key="is raw layer">
				<TooltipTrigger>
					<Icons.ShieldOff className="text-red-500" />
				</TooltipTrigger>
				<TooltipContent>
					<p>
						This layer is unknown and was not able to be fully parsed (<b>{props.layerId.slice('RAW:'.length)}</b>)
					</p>
				</TooltipContent>
			</Tooltip>,
		)
	}

	return (
		<div className="flex space-x-2 items-center">
			<span className="flex-1 text-nowrap">{DH.toShortLayerNameFromId(props.layerId)}</span>
			<span className="flex items-center space-x-1">
				{badges}
			</span>
		</div>
	)
}
