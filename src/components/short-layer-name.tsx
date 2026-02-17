import { getTeamsDisplay } from '@/components/teams-display.tsx'

import * as Obj from '@/lib/object'
import { isNullOrUndef } from '@/lib/type-guards.ts'
import * as Typo from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import { GlobalSettingsStore } from '@/systems/global-settings.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import LayerInfoDialog from './layer-info'
import MapLayerDisplay from './map-layer-display.tsx'

void import('./layer-info')

export default function ShortLayerName(
	{ layerId, teamParity, backfillLayerId, matchDescriptors, allowShowInfo: _allowShowInfo, ref, className }: {
		layerId: L.LayerId
		teamParity?: number
		backfillLayerId?: L.LayerId
		matchDescriptors?: LQY.MatchDescriptor[]
		allowShowInfo?: boolean
		className?: string
		ref?: React.Ref<HTMLDivElement>
	},
) {
	const allowShowInfo = _allowShowInfo ?? true
	const backfilledStyle = 'text-gray-500'

	const globalSettings = Zus.useStore(GlobalSettingsStore)
	let partialLayer = Obj.trimUndefined(L.toLayer(layerId))
	let backfillLayer: Partial<L.KnownLayer> | undefined
	if (backfillLayerId) {
		backfillLayer = L.toLayer(backfillLayerId)
	}

	const extraStyles = React.useMemo(() => {
		let violatedFieldDescriptors: Map<keyof L.KnownLayer, LQY.MatchDescriptor> = new Map()
		if (matchDescriptors && !isNullOrUndef(teamParity)) {
			violatedFieldDescriptors = LQY.resolveRepeatedFieldToDescriptorMap(matchDescriptors, teamParity)
		}
		const combineStyles = (prop: keyof typeof partialLayer) => {
			const styles: string[] = []

			// Add backfilled style if applicable
			if (!partialLayer[prop] && !!backfillLayer?.[prop]) {
				styles.push(backfilledStyle)
			}

			// Add violation style if applicable
			if (violatedFieldDescriptors.has(prop)) {
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
			Collection: combineStyles('Collection'),
		}
		return extraStyles
	}, [
		partialLayer,
		backfillLayer,
		matchDescriptors,
		teamParity,
	])

	if (!partialLayer.Layer) return layerId.slice('RAW:'.length)
	partialLayer = React.useMemo(() => ({ ...(backfillLayer ?? {}), ...partialLayer }), [backfillLayer, partialLayer])

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
	const content = (
		<span className={cn('inline-flex items-baseline', className)} ref={ref}>
			{partialLayer.Layer && <MapLayerDisplay layer={partialLayer.Layer} extraLayerStyles={extraStyles} />}
			{partialLayer.Faction_1 && partialLayer.Faction_2 && (
				<>
					<Icons.Dot className="self-center" width={20} height={20} />
					{leftTeamElt}
					<span className="mx-1">vs</span>
					{rightTeamElt}
				</>
			)}
		</span>
	)
	if (!allowShowInfo || !L.isKnownLayer(layerId)) return content
	return (
		<LayerInfoDialog layerId={layerId}>
			<button type="button" className="text-primary underline-offset-4 [&:hover>span]:underline">
				{content}
			</button>
		</LayerInfoDialog>
	)
}
