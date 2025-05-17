import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useLayerStatuses } from '@/hooks/use-layer-queries.ts'
import * as DH from '@/lib/display-helpers'
import { getTeamsDisplay } from '@/lib/display-helpers-react.tsx'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { ConstraintViolationDisplay } from './constraint-violation-display.tsx'

export default function LayerDisplay(
	props: { layerId: M.LayerId; itemId?: string; isVoteChoice?: boolean; badges?: React.ReactNode[]; normTeamOffset?: 0 | 1 },
) {
	const layerStatusesRes = useLayerStatuses({ enabled: !!props.itemId })
	const badges: React.ReactNode[] = []
	const constraints = ZusUtils.useStoreDeep(QD.QDStore, s => M.getPoolConstraints(s.editedServerState.settings.queue.mainPool))
	if (props.badges) badges.push(...props.badges)

	if (layerStatusesRes.data && !!props.itemId) {
		const exists = layerStatusesRes.data.present.has(props.layerId)
		if (!exists && !M.isRawLayerId(props.layerId)) {
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

		const blockingConstraintIds = props.itemId
			? layerStatusesRes.data?.blocked.get(
				M.toQueueLayerKey(props.itemId, props.isVoteChoice ? props.layerId : undefined),
			)
			: undefined

		if (blockingConstraintIds) {
			badges.push(
				<ConstraintViolationDisplay
					key="constraint violation display"
					violated={Array.from(blockingConstraintIds).map(id => constraints.find(c => c.id === id)!)}
					violationDescriptors={props.itemId ? layerStatusesRes.data?.violationDescriptors.get(props.itemId) : undefined}
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
			<span className="flex-1 text-nowrap">
				<ShortLayerName layerId={props.layerId} normTeamOffset={props.normTeamOffset} />
			</span>
			<span className="flex items-center space-x-1">
				{badges}
			</span>
		</div>
	)
}

function ShortLayerName({ layerId, normTeamOffset }: { layerId: M.LayerId; normTeamOffset?: 0 | 1 }) {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const partialLayer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(layerId))

	if (!partialLayer.Map || !partialLayer.Gamemode || !partialLayer.Faction_1 || !partialLayer.Faction_1) return layerId.slice('RAW:'.length)

	const [leftTeamElt, rightTeamElt] = getTeamsDisplay(
		partialLayer,
		normTeamOffset,
		globalSettings.displayLayersNormalized,
	)

	return (
		<div className="flex items-center space-x-1">
			<span>{partialLayer.Layer}</span>
			<span>-</span>
			{leftTeamElt}
			<span>vs</span>
			{rightTeamElt}
		</div>
	)
}
