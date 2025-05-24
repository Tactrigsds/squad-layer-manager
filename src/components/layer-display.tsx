import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { getTeamsDisplay } from '@/lib/display-helpers-react.tsx'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import { useLayerStatuses } from '@/systems.client/layer-queries.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { ConstraintViolationDisplay } from './constraint-violation-display.tsx'

export default function LayerDisplay(
	props: {
		layerId: M.LayerId
		itemId?: string
		isVoteChoice?: boolean
		badges?: React.ReactNode[]
		teamParity?: number
		backfillLayerId?: M.LayerId
	},
) {
	const layerStatusesRes = useLayerStatuses({ enabled: !!props.itemId })
	const badges: React.ReactNode[] = []
	const constraints = ZusUtils.useStoreDeep(QD.QDStore, s => M.getPoolConstraints(s.editedServerState.settings.queue.mainPool))
	if (props.badges) badges.push(...props.badges)

	const blockingConstraintIds = props.itemId
		? layerStatusesRes.data?.blocked.get(
			M.toQueueLayerKey(props.itemId, props.isVoteChoice ? props.layerId : undefined),
		)
		: undefined

	if (blockingConstraintIds) {
		badges.push(
			<ConstraintViolationDisplay
				key="constraint violation display"
				violated={Array.from(blockingConstraintIds).map(id => constraints.find(c => c.id === id)).filter(c => c !== undefined)}
				violationDescriptors={props.itemId ? layerStatusesRes.data?.violationDescriptors.get(props.itemId) : undefined}
				layerId={props.layerId}
			/>,
		)
	}

	if (layerStatusesRes.data && !!props.itemId) {
		const exists = layerStatusesRes.data.present.has(props.layerId)
		if (!exists && !M.isRawLayerId(props.layerId)) {
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
				<ShortLayerName layerId={props.layerId} teamParity={props.teamParity} backfillLayerId={props.backfillLayerId} />
			</span>
			<span className="flex items-center space-x-1">
				{badges}
			</span>
		</div>
	)
}

function ShortLayerName(
	{ layerId, teamParity, backfillLayerId }: { layerId: M.LayerId; teamParity?: number; backfillLayerId?: M.LayerId },
) {
	const backfilledStyle = 'text-gray-500'

	const globalSettings = Zus.useStore(GlobalSettingsStore)
	let partialLayer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(layerId))
	partialLayer = Obj.trimUndefined(partialLayer)
	let backfillLayer: Partial<M.MiniLayer> | undefined
	if (backfillLayerId) {
		backfillLayer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(backfillLayerId))
	}

	const withBackfilledStyles: Record<keyof M.MiniLayer, string | undefined> = {
		id: undefined,
		Layer: (!partialLayer.Layer && !!backfillLayer?.Layer) ? backfilledStyle : undefined,
		Map: (!partialLayer.Map && !!backfillLayer?.Map) ? backfilledStyle : undefined,
		Gamemode: (!partialLayer.Gamemode && !!backfillLayer?.Gamemode) ? backfilledStyle : undefined,
		LayerVersion: (!partialLayer.LayerVersion && !!backfillLayer?.LayerVersion) ? backfilledStyle : undefined,
		Faction_1: (!partialLayer.Faction_1 && !!backfillLayer?.Faction_1) ? backfilledStyle : undefined,
		SubFac_1: (!partialLayer.SubFac_1 && !!backfillLayer?.SubFac_1) ? backfilledStyle : undefined,
		Faction_2: (!partialLayer.Faction_2 && !!backfillLayer?.Faction_2) ? backfilledStyle : undefined,
		SubFac_2: (!partialLayer.SubFac_2 && !!backfillLayer?.SubFac_2) ? backfilledStyle : undefined,
	}

	if (!partialLayer.Layer) return layerId.slice('RAW:'.length)
	partialLayer = { ...(backfillLayer ?? {}), ...partialLayer }

	let leftTeamElt: React.ReactNode | undefined
	let rightTeamElt: React.ReactNode | undefined

	if (partialLayer.Faction_1 && partialLayer.Faction_2) {
		;[leftTeamElt, rightTeamElt] = getTeamsDisplay(
			partialLayer,
			teamParity ?? 0,
			globalSettings.displayTeamsNormalized,
			withBackfilledStyles,
		)
	}

	return (
		<div className="flex items-center space-x-1">
			<span className={withBackfilledStyles.Layer}>{partialLayer.Layer}</span>
			{partialLayer.Faction_1 && partialLayer.Faction_2 && (
				<>
					<span>-</span>
					{leftTeamElt}
					{<span>vs</span>}
					{rightTeamElt}
				</>
			)}
		</div>
	)
}
