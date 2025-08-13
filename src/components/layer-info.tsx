import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import * as LQY from '@/models/layer-queries.models'
import * as SLL from '@/models/squad-layer-list.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import { Info } from 'lucide-react'
import React from 'react'
import MapLayerDisplay from './map-layer-display.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'

type LayerInfoProps = {
	layerId: L.LayerId
	children: React.ReactNode
}
export default function LayerInfoWrapper(props: LayerInfoProps) {
	const isKnownLayer = L.isKnownLayer(props.layerId)
	if (!isKnownLayer) return null
	return <LayerInfo {...props} />
}
function LayerInfo(props: LayerInfoProps) {
	const layerConstraint = LQY.filterToConstraint(FB.comp(FB.eq('id', props.layerId)), 'get-layer')
	const constraints: LQY.LayerQueryConstraint[] = [layerConstraint]
	const layerRes = LayerQueriesClient.useLayersQuery({ constraints })
	const cfg = ConfigClient.useEffectiveColConfig()
	let scores: LC.PartitionedScores | undefined
	let layerDetails:
		| { layer: L.KnownLayer; team1?: L.FactionUnitConfig; team2?: L.FactionUnitConfig; layerConfig?: L.LayerConfig }
		| undefined

	if (layerRes.data && cfg) {
		const layer = layerRes.data.layers[0]
		scores = LC.partitionScores(layer, cfg)

		try {
			const resolved = L.resolveLayerDetails(layer)
			const layerConfig = L.StaticLayerComponents.mapLayers.find(l => l.Layer === layer.Layer)
			layerDetails = {
				...resolved,
				layerConfig,
			}
		} catch (error) {
			console.warn('Failed to resolve layer details:', error)
		}
	}

	return (
		<Popover>
			<PopoverTrigger asChild>
				{props.children}
			</PopoverTrigger>
			<PopoverContent className="w-max">
				<div className="space-y-3">
					<MapLayerDisplay layer={L.toLayer(props.layerId).Layer} extraLayerStyles={undefined} />
					{layerDetails && <LayerDetailsDisplay layerDetails={layerDetails} />}
					{scores && <ScoreGrid scores={scores} />}
				</div>
			</PopoverContent>
		</Popover>
	)
}

function LayerDetailsDisplay(
	{ layerDetails }: {
		layerDetails: { layer: L.KnownLayer; team1?: L.FactionUnitConfig; team2?: L.FactionUnitConfig; layerConfig?: L.LayerConfig }
	},
) {
	return (
		<div className="space-y-2 border-b pb-3">
			{layerDetails.layerConfig && <LayerConfigInfo layerConfig={layerDetails.layerConfig} />}
			<div className="grid grid-cols-2 gap-3">
				<TeamInfo
					title="Team 1"
					unit={layerDetails.team1}
					faction={layerDetails.layer.Faction_1}
				/>
				<TeamInfo
					title="Team 2"
					unit={layerDetails.team2}
					faction={layerDetails.layer.Faction_2}
				/>
			</div>
		</div>
	)
}

function TeamInfo({
	title,
	unit,
	faction,
}: {
	title: string
	unit: L.FactionUnitConfig | undefined
	faction: string
}) {
	const groupedVehicles = unit?.vehicles ? groupVehiclesByRowName(unit.vehicles) : {}

	return (
		<div className="space-y-1">
			<h4 className="text-sm font-medium">{title}</h4>
			<div className="text-xs space-y-0.5">
				<div className="text-gray-400">
					<div>
						<strong>Faction:</strong> {faction} ({unit?.type || 'UNKNOWN'})
					</div>
					<div>
						<strong>Display Name:</strong> {unit?.displayName || 'Unknown'}
					</div>
				</div>

				{Object.keys(groupedVehicles).length > 0 && (
					<div className="mt-1">
						<div className="text-gray-400 font-medium mb-1">Vehicles:</div>
						<div className="grid grid-cols-[auto_1fr_2fr] gap-x-3 text-sm text-gray-400 whitespace-nowrap">
							<div className="text-right font-medium">#</div>
							<div className="flex items-center gap-1 font-medium">
								Delay/Respawn
								<Popover>
									<PopoverTrigger>
										<Info size={16} className="text-blue-400 hover:text-blue-300 cursor-pointer" />
									</PopoverTrigger>
									<PopoverContent className="w-max">
										<div className="space-y-1">
											<div>
												<strong>Format:</strong> Delay/Respawn (in minutes)
											</div>
											<div>
												<strong>Delay:</strong> Time before first spawn
											</div>
											<div>
												<strong>Respawn:</strong> Time between subsequent spawns
											</div>
										</div>
									</PopoverContent>
								</Popover>
							</div>
							<div className="font-medium">Vehicle</div>
							{Object.entries(groupedVehicles).map(([rowName, vehicles]) => (
								<VehicleRow key={rowName} vehicles={vehicles as SLL.Vehicle[]} />
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

function VehicleRow({ vehicles }: { vehicles: SLL.Vehicle[] }) {
	const totalCount = vehicles.reduce((sum, v) => sum + v.count, 0)
	const vehicle = vehicles[0]
	const hasDelayed = vehicles.some(v => v.delay > 0)

	// For delay/respawn format, use the first vehicle's values
	// If mixed delays, show the delayed vehicle's delay, otherwise 0
	const displayDelay = hasDelayed ? vehicles.find(v => v.delay > 0)?.delay || 0 : 0
	const delayRespawnInfo = `${displayDelay}/${vehicle.respawnTime}`

	return (
		<>
			<div className="text-right">{totalCount}</div>
			<div>{delayRespawnInfo}</div>
			<div>{vehicle.name}</div>
		</>
	)
}

function groupVehiclesByRowName(vehicles: SLL.Vehicle[]) {
	return vehicles.reduce((groups, vehicle) => {
		const key = vehicle.rowName
		if (!groups[key]) {
			groups[key] = []
		}
		groups[key].push(vehicle)
		return groups
	}, {} as Record<string, SLL.Vehicle[]>)
}

function LayerConfigInfo({ layerConfig }: { layerConfig: L.LayerConfig }) {
	return (
		<div className="text-xs text-muted-foreground space-y-0.5">
			{!layerConfig.hasCommander && (
				<div>
					<strong>Commander:</strong> Disabled
				</div>
			)}
			{layerConfig.persistentLightingType && (
				<div>
					<strong>Lighting:</strong> {layerConfig.persistentLightingType}
				</div>
			)}
		</div>
	)
}

function ScoreGrid({ scores }: { scores: LC.PartitionedScores }) {
	const scoreTypes = Object.keys(scores.diffs)

	return (
		<div className="grid gap-2">
			{scoreTypes.map(scoreType => (
				<ScoreRow
					key={scoreType}
					scoreType={scoreType}
					team1Score={scores.team1[scoreType] || 0}
					team2Score={scores.team2[scoreType] || 0}
					diff={scores.diffs[scoreType] || 0}
				/>
			))}
		</div>
	)
}

function ScoreRow({
	scoreType,
	team1Score,
	team2Score,
	diff,
}: {
	scoreType: string
	team1Score: number
	team2Score: number
	diff: number
}) {
	const maxScore = Math.max(Math.abs(team1Score), Math.abs(team2Score))
	const normalizedDiff = maxScore > 0 ? (diff / (maxScore * 2)) : 0
	const balancePercentage = 50 + (normalizedDiff * 50)

	return (
		<div className="space-y-1">
			<div className="flex justify-between items-center">
				<span className="text-sm font-medium">{scoreType.replace(/_/g, ' ')}</span>
				<span className="text-xs text-muted-foreground">
					{team1Score.toFixed(1)} vs {team2Score.toFixed(1)}
				</span>
			</div>
			<div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					className="absolute top-0 left-0 h-full bg-blue-500 transition-all duration-200"
					style={{ width: `${Math.min(balancePercentage, 100)}%` }}
				/>
				<div
					className="absolute top-0 right-0 h-full bg-red-500 transition-all duration-200"
					style={{ width: `${Math.min(100 - balancePercentage, 100)}%` }}
				/>
				<div className="absolute top-0 left-1/2 w-0.5 h-full bg-foreground/20 transform -translate-x-0.5" />
			</div>
			<div className="text-xs text-center text-muted-foreground">
				Diff: {diff.toFixed(2)}
			</div>
		</div>
	)
}
