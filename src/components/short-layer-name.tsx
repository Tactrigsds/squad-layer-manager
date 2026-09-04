import React from 'react'

import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as L from '@/models/layer'
import type * as LQY from '@/models/layer-queries.models.ts'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'

import * as Atoms from './feed/atoms'
import LayerInfoDialog from './layer-info'

void import('./layer-info')

/**
 * A layer's name, broken into its parts.
 *
 * The parts are built by Atoms.shortLayerNameContent, which the activity feed uses directly. What stays here is the
 * host element: it takes a forwarded ref (the queue's rows make it a drop target) and the layer-info affordance,
 * neither of which survives `display:contents`.
 */
export default function ShortLayerName({
	layerId,
	teamParity,
	backfillLayerId,
	matchDescriptors,
	allowShowInfo: _allowShowInfo,
	normalized,
	tourId,
	ref,
	className,
}: {
	layerId: L.LayerId
	teamParity?: number
	backfillLayerId?: L.LayerId
	matchDescriptors?: LQY.MatchDescriptor[]
	allowShowInfo?: boolean
	// overrides the global displayTeamsNormalized setting; see TeamFactionDisplay
	normalized?: boolean
	tourId?: string
	className?: string
	ref?: React.Ref<HTMLSpanElement>
}) {
	const allowShowInfo = _allowShowInfo ?? true
	const globalNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const content = (
		<Atoms.ShortLayerNameContent
			layerId={layerId}
			teamParity={teamParity}
			backfillLayerId={backfillLayerId}
			matchDescriptors={matchDescriptors}
			normalized={normalized ?? globalNormalized}
		/>
	)

	// an unparseable layer id is its own display, with nothing to break into parts and nothing to look up
	if (!L.toLayer(layerId).Layer) return content

	const host = (
		<span data-tour={tourId} className={cn('fd-layer-name inline-flex flex-wrap items-baseline', className)} ref={ref}>
			{content}
		</span>
	)
	if (!allowShowInfo || !L.isKnownLayer(layerId)) return host
	return (
		<LayerInfoDialog layerId={layerId}>
			<button type="button" className="text-primary underline-offset-4 [&:hover>span]:underline">
				{host}
			</button>
		</LayerInfoDialog>
	)
}
