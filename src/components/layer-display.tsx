import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { getTeamsDisplay } from '@/lib/display-helpers-teams.tsx'
import * as Obj from '@/lib/object'
import { isNullOrUndef } from '@/lib/typeGuards.ts'
import * as Typo from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
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
		historyEntryId?: number
		isVoteChoice?: boolean
		badges?: React.ReactNode[]
		teamParity?: number
		backfillLayerId?: M.LayerId
	},
) {
	const layerStatusesRes = useLayerStatuses({ enabled: !!props.itemId })
	const badges: React.ReactNode[] = []
	const constraints = ZusUtils.useStoreDeep(QD.QDStore, s => M.getPoolConstraints(s.editedServerState.settings.queue.mainPool))
	const hoveredConstraintItemId = Zus.useStore(QD.QDStore, s => s.hoveredConstraintItemId)
	const allViolationDescriptors = layerStatusesRes.data?.violationDescriptors
	// violations that this item has caused for the hovered item
	const hoveredReasonViolationDescriptors = (hoveredConstraintItemId && hoveredConstraintItemId !== props.itemId
		&& allViolationDescriptors?.get(hoveredConstraintItemId)?.filter(vd => {
			if (props.historyEntryId) return vd.reasonItem?.type === 'history-entry' && vd.reasonItem.historyEntryId === props.historyEntryId
			if (props.itemId) return vd.reasonItem?.type === 'layer-list-item' && vd.reasonItem.layerListItemId === props.itemId
		})) || undefined
	const localViolationDescriptors = (props.itemId && hoveredConstraintItemId === props.itemId && allViolationDescriptors?.get(props.itemId))
		|| undefined
	if (props.layerId?.startsWith('SM')) {
		console.log({
			layerId: props.layerId,
			itemId: props.itemId,
			hoveredItemId: hoveredConstraintItemId,
			localViolationDescriptors,
			hoveredReasonViolationDescriptors,
			allViolationDescriptors,
		})
	}
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
				itemId={props.itemId}
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
				<ShortLayerName
					layerId={props.layerId}
					teamParity={props.teamParity}
					backfillLayerId={props.backfillLayerId}
					violationDescriptors={localViolationDescriptors || hoveredReasonViolationDescriptors || undefined}
				/>
			</span>
			<span className="flex items-center space-x-1">
				{badges}
			</span>
		</div>
	)
}

function ShortLayerName(
	{ layerId, teamParity, backfillLayerId, violationDescriptors }: {
		layerId: M.LayerId
		teamParity?: number
		backfillLayerId?: M.LayerId
		violationDescriptors?: M.ViolationDescriptor[]
	},
) {
	const backfilledStyle = 'text-gray-500'

	const globalSettings = Zus.useStore(GlobalSettingsStore)
	let partialLayer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(layerId))
	partialLayer = Obj.trimUndefined(partialLayer)
	let backfillLayer: Partial<M.MiniLayer> | undefined
	if (backfillLayerId) {
		backfillLayer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(backfillLayerId))
	}

	// Create violation field mapping
	let violatedFields = new Set<string>()
	if (violationDescriptors && !isNullOrUndef(teamParity)) {
		violatedFields = M.resolveViolatedLayerProperties(violationDescriptors, teamParity)
	}
	if (violatedFields.size > 0) {
		console.log({ violatedFields })
	}

	const combineStyles = (field: keyof typeof partialLayer) => {
		const styles: string[] = []

		// Add backfilled style if applicable
		if (!partialLayer[field] && !!backfillLayer?.[field]) {
			styles.push(backfilledStyle)
		}

		// Add violation style if applicable
		if (violatedFields.has(field)) {
			styles.push(Typo.ConstraintViolationDescriptor)
		}

		return styles.length > 0 ? styles.join(' ') : undefined
	}

	const extraStyles: Record<keyof M.MiniLayer, string | undefined> = {
		id: undefined,
		Layer: combineStyles('Layer'),
		Size: combineStyles('Size'),
		Map: combineStyles('Map'),
		Gamemode: combineStyles('Gamemode'),
		LayerVersion: combineStyles('LayerVersion'),
		Faction_1: combineStyles('Faction_1'),
		Unit_1: combineStyles('Unit_1'),
		Alliance_1: combineStyles('Alliance_1'),
		Faction_2: combineStyles('Faction_2'),
		Unit_2: combineStyles('Unit_2'),
		Alliance_2: combineStyles('Alliance_2'),
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
			extraStyles,
		)
	}

	return (
		<div className="flex items-center space-x-1">
			{partialLayer.Layer && <MapLayerDisplay layer={partialLayer.Layer} extraLayerStyles={extraStyles} />}
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

export function MapLayerDisplay(
	{ layer, extraLayerStyles: backfilledStyles, className }: {
		layer: string
		extraLayerStyles: Record<string, string | undefined>
		className?: string
	},
) {
	const segments = M.parseLayerStringSegment(layer)
	if (!segments || segments.Gamemode === 'Training') return layer
	return (
		<span className={cn(backfilledStyles.Layer, className)}>
			<span className={backfilledStyles.Map}>{segments.Map}</span>
			{segments.Gamemode && '_'}
			<span className={backfilledStyles.Gamemode}>{segments.Gamemode}</span>
			{segments.LayerVersion && '_'}
			<span className={backfilledStyles.Layer}>{segments.LayerVersion?.toLowerCase()}</span>
		</span>
	)
}
