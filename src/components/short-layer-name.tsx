import { getTeamsDisplay } from '@/lib/display-helpers-teams.tsx'
import * as Obj from '@/lib/object'
import { OneToManyMap } from '@/lib/one-to-many-map.ts'
import { isNullOrUndef } from '@/lib/type-guards.ts'
import * as Typo from '@/lib/typography.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import React from 'react'
import * as Zus from 'zustand'
import LayerInfo from './layer-info'
import MapLayerDisplay from './map-layer-display.tsx'
import { Button } from './ui/button.tsx'

export default function ShortLayerName(
	{ layerId, teamParity, backfillLayerId, violationDescriptors, allowShowInfo }: {
		layerId: L.LayerId
		teamParity?: number
		backfillLayerId?: L.LayerId
		violationDescriptors?: LQY.ViolationDescriptor[]
		allowShowInfo?: boolean
	},
) {
	allowShowInfo ??= true
	const backfilledStyle = 'text-gray-500'

	const globalSettings = Zus.useStore(GlobalSettingsStore)
	let partialLayer = L.toLayer(layerId)
	partialLayer = Obj.trimUndefined(partialLayer)
	let backfillLayer: Partial<L.KnownLayer> | undefined
	if (backfillLayerId) {
		backfillLayer = L.toLayer(backfillLayerId)
	}

	// Create violation field mapping
	let violatedFields: OneToManyMap<string, LQY.ViolationDescriptor> = new Map()
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
	const content = (
		<div className="flex items-center space-x-1">
			{partialLayer.Layer && <MapLayerDisplay layer={partialLayer.Layer} extraLayerStyles={extraStyles} />}
			{partialLayer.Faction_1 && partialLayer.Faction_2 && (
				<>
					<span className="px-1">-</span>
					{leftTeamElt}
					{<span>vs</span>}
					{rightTeamElt}
				</>
			)}
		</div>
	)
	if (!allowShowInfo) return content
	return (
		<LayerInfo layerId={layerId}>
			<Button variant="link">{content}</Button>
		</LayerInfo>
	)
}
