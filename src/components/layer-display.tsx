import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import { useLayerItemStatuses } from '@/systems.client/layer-queries.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import deepEqual from 'fast-deep-equal'
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
		<div className={cn('flex space-x-2 items-center', props.className)} ref={props.ref}>
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
