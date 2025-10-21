import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import { useLayerItemStatuses } from '@/systems.client/layer-queries.client.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { ConstraintViolationDisplay } from './constraint-violation-display.tsx'
import ShortLayerName from './short-layer-name.tsx'

export default function LayerDisplay(
	props: {
		item: LQY.LayerItem
		badges?: React.ReactNode[]
		backfillLayerId?: L.LayerId
		addedLayerQueryInput?: Pick<LQY.LayerQueryBaseInput, 'patches'>
		allowShowInfo?: boolean
		className?: string
		ref?: React.Ref<HTMLDivElement>
	},
) {
	const layerStatusesRes = useLayerItemStatuses({ addedInput: props.addedLayerQueryInput })
	const badges: React.ReactNode[] = []
	const constraints = ZusUtils.useStoreDeep(ServerSettingsClient.Store, s => SS.getPoolConstraints(s.saved.queue.mainPool))
	const hoveredConstraintItemId = Zus.useStore(LayerQueriesClient.Store, s => s.hoveredConstraintItemId ?? undefined)
	const allViolationDescriptors = layerStatusesRes.data?.violationDescriptors
	const teamParity = ReactRxHelpers.useStateObservableSelection(
		QD.layerItemsState$,
		React.useCallback((context) => LQY.getParityForLayerItem(context, props.item), [props.item]),
	) ?? 0

	const layerItemId = LQY.toLayerItemId(props.item)
	// violations that this item has caused for the hovered item
	const hoveredReasonViolationDescriptors = (hoveredConstraintItemId && hoveredConstraintItemId !== layerItemId
		&& allViolationDescriptors?.get(hoveredConstraintItemId)?.filter(vd => vd.reasonItem && Obj.deepEqual(vd.reasonItem, props.item)))
		|| undefined

	const localViolationDescriptors = hoveredConstraintItemId === layerItemId && allViolationDescriptors?.get(layerItemId)
		|| undefined

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

	if (props.badges) badges.push(...props.badges)

	const layer = L.toLayer(props.item.layerId)
	if (layerStatusesRes.data) {
		const exists = layerStatusesRes.data.present.has(props.item.layerId)
		if (!exists) {
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
	}

	return (
		<div className={cn('flex space-x-2 items-center', props.className)} ref={props.ref}>
			<span className="flex-1 text-nowrap">
				<ShortLayerName
					layerId={props.item.layerId}
					teamParity={teamParity}
					backfillLayerId={props.backfillLayerId}
					violationDescriptors={localViolationDescriptors || hoveredReasonViolationDescriptors || undefined}
					allowShowInfo={props.allowShowInfo}
				/>
			</span>
			<span className="flex items-center space-x-1">
				{badges}
			</span>
		</div>
	)
}
