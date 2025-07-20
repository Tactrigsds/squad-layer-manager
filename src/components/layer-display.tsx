import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { getTeamsDisplay } from '@/lib/display-helpers-teams.tsx'
import * as Obj from '@/lib/object'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers.ts'
import { isNullOrUndef } from '@/lib/type-guards.ts'
import * as Typo from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as MH from '@/models/match-history.models.ts'
import * as SS from '@/models/server-state.models.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import { useLayerStatuses } from '@/systems.client/layer-queries.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import deepEqual from 'fast-deep-equal'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { ConstraintViolationDisplay } from './constraint-violation-display.tsx'

export default function LayerDisplay(
	props: {
		item: LQY.LayerItem
		badges?: React.ReactNode[]
		backfillLayerId?: L.LayerId
	},
) {
	const layerStatusesRes = useLayerStatuses()
	const badges: React.ReactNode[] = []
	const constraints = ZusUtils.useStoreDeep(QD.QDStore, s => SS.getPoolConstraints(s.editedServerState.settings.queue.mainPool))
	const hoveredConstraintItemId = Zus.useStore(QD.QDStore, s => s.hoveredConstraintItemId)
	const allViolationDescriptors = layerStatusesRes.data?.violationDescriptors
	const teamParity = ReactRxHelpers.useStateObservableSelection(
		QD.layerItemsState$,
		React.useCallback((context) => LQY.getParityForLayerItem(context, props.item), [props.item]),
	) ?? 0

	const layerItemId = LQY.toLayerItemId(props.item)
	// violations that this item has caused for the hovered item
	const hoveredReasonViolationDescriptors = (hoveredConstraintItemId && hoveredConstraintItemId !== layerItemId
		&& allViolationDescriptors?.get(hoveredConstraintItemId)?.filter(vd => vd.reasonItem && deepEqual(vd.reasonItem, props.item)))
		|| undefined

	const localViolationDescriptors = hoveredConstraintItemId === layerItemId && allViolationDescriptors?.get(layerItemId)
		|| undefined

	if (props.badges) badges.push(...props.badges)

	const blockingConstraintIds = layerStatusesRes.data?.blocked.get(layerItemId)

	if (blockingConstraintIds) {
		badges.push(
			<ConstraintViolationDisplay
				key="constraint violation display"
				violated={Array.from(blockingConstraintIds).map(id => constraints.find(c => c.id === id)).filter(c => c !== undefined)}
				violationDescriptors={layerStatusesRes.data?.violationDescriptors.get(layerItemId)}
				itemId={layerItemId}
			/>,
		)
	}

	if (layerStatusesRes.data) {
		const exists = layerStatusesRes.data.present.has(props.item.layerId)
		if (!exists && !L.isRawLayerId(props.item.layerId)) {
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

	if (L.isRawLayerId(props.item.layerId)) {
		badges.push(
			<Tooltip key="is raw layer">
				<TooltipTrigger>
					<Icons.ShieldOff className="text-red-500" />
				</TooltipTrigger>
				<TooltipContent>
					<p>
						This layer is unknown and was not able to be fully parsed (<b>{props.item.layerId.slice('RAW:'.length)}</b>)
					</p>
				</TooltipContent>
			</Tooltip>,
		)
	}

	return (
		<div className="flex space-x-2 items-center">
			<span className="flex-1 text-nowrap">
				<ShortLayerName
					layerId={props.item.layerId}
					teamParity={teamParity}
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
		layerId: L.LayerId
		teamParity?: number
		backfillLayerId?: L.LayerId
		violationDescriptors?: LQY.ViolationDescriptor[]
	},
) {
	const backfilledStyle = 'text-gray-500'

	const globalSettings = Zus.useStore(GlobalSettingsStore)
	let partialLayer = L.toLayer(layerId)
	partialLayer = Obj.trimUndefined(partialLayer)
	let backfillLayer: Partial<L.KnownLayer> | undefined
	if (backfillLayerId) {
		backfillLayer = L.toLayer(backfillLayerId)
	}

	// Create violation field mapping
	let violatedFields = new Set<string>()
	if (violationDescriptors && !isNullOrUndef(teamParity)) {
		violatedFields = LQY.resolveViolatedLayerProperties(violationDescriptors, teamParity)
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

	const extraStyles: Record<keyof L.KnownLayer, string | undefined> = {
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
	const segments = L.parseLayerStringSegment(layer)
	if (!segments || segments.Gamemode === 'Training') return layer
	return (
		<span className={cn(backfilledStyles.Layer, className)}>
			<span className={backfilledStyles.Map}>{segments.Map}</span>
			{segments.Gamemode && '_'}
			<span className={backfilledStyles.Gamemode}>{segments.Gamemode}</span>
			{segments.LayerVersion && segments.Gamemode && '_'}
			<span className={backfilledStyles.Layer}>{segments.LayerVersion?.toLowerCase()}</span>
		</span>
	)
}
