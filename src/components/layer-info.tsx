import scoreRanges from '$root/assets/score-ranges.json'
import { upperSnakeCaseToPascalCase } from '@/lib/string.ts'
import * as Typography from '@/lib/typography'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import * as LQY from '@/models/layer-queries.models'
import * as SLL from '@/models/squad-layer-list.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import { Car, Info } from 'lucide-react'
import React, { useState } from 'react'
import MapLayerDisplay from './map-layer-display.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'
import TabsList from './ui/tabs-list.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

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
	const [activeTab, setActiveTab] = useState<'details' | 'scores'>('details')
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

	console.log('scores:', scores)
	const hasScores = scores && Object.values(scores).some(score => typeof score === 'number')
	return (
		<Popover modal={true}>
			<PopoverTrigger asChild>
				{props.children}
			</PopoverTrigger>
			<PopoverContent align="center" className="w-max">
				<div className="space-y-3">
					<div className="flex justify-between items-center space-x-2">
						<div className="flex items-center gap-3">
							<MapLayerDisplay layer={L.toLayer(props.layerId).Layer} extraLayerStyles={undefined} />
							{layerDetails?.layerConfig && <LayerConfigInfo layerConfig={layerDetails.layerConfig} />}
						</div>
						{hasScores && (
							<TabsList
								options={[
									{ value: 'details', label: 'Details' },
									{ value: 'scores', label: 'Scores' },
								]}
								active={activeTab}
								setActive={setActiveTab}
							/>
						)}
					</div>
					{activeTab === 'details' && layerDetails && <LayerDetailsDisplay layerDetails={layerDetails} />}
					{activeTab === 'details' && !layerDetails && <div>No details available</div>}
					{activeTab === 'scores' && scores && <ScoreGrid scores={scores} layerDetails={layerDetails} />}
					{activeTab === 'scores' && !scores && <div>No scores available</div>}
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
	const team1Vehicles = layerDetails.team1?.vehicles || []
	const team2Vehicles = layerDetails.team2?.vehicles || []

	return (
		<div className="space-y-3 border-b pb-3">
			{/* 2x2 Grid Layout */}
			<div className="grid grid-cols-2 grid-rows-[auto_auto] gap-4">
				{/* Team Info Row */}
				<TeamInfoOnly
					title="Team 1"
					unit={layerDetails.team1}
					faction={layerDetails.layer.Faction_1}
					role={layerDetails.layerConfig?.teams[0].role}
					tickets={layerDetails.layerConfig?.teams[0].tickets}
				/>
				<TeamInfoOnly
					title="Team 2"
					unit={layerDetails.team2}
					faction={layerDetails.layer.Faction_2}
					role={layerDetails.layerConfig?.teams[1].role}
					tickets={layerDetails.layerConfig?.teams[1].tickets}
				/>

				{/* Vehicles Row */}
				<VehiclesOnly
					title="Team 1 Vehicles"
					vehicles={team1Vehicles}
				/>
				<VehiclesOnly
					title="Team 2 Vehicles"
					vehicles={team2Vehicles}
				/>
			</div>
		</div>
	)
}

function TeamInfoOnly({
	title,
	unit,
	faction,
	role,
	tickets,
}: {
	title: string
	unit: L.FactionUnitConfig | undefined
	faction: string
	role?: string
	tickets?: number
}) {
	return (
		<section className="space-y-1">
			<div className="text-sm">
				<strong>{title}{role && ` (${role})`}</strong> - {faction} ({upperSnakeCaseToPascalCase(unit?.type || 'UNKNOWN')})
			</div>
			<div className="text-sm font-light">
				{unit?.displayName || 'Unknown'}
			</div>
			{tickets && (
				<div className="text-xs text-muted-foreground">
					<strong>Starting Tickets:</strong> {tickets}
				</div>
			)}

			{unit && unit.characteristics && unit.characteristics.length > 0 && (
				<div className="mt-4">
					<ul className="space-y-0.5 text-xs font-light ml-4 mt-2">
						{unit.characteristics.map((char, index) => <li key={index} className="list-disc">{char.description}</li>)}
					</ul>
				</div>
			)}
		</section>
	)
}

function VehiclesOnly({
	title,
	vehicles,
}: {
	title: string
	vehicles: SLL.Vehicle[]
}) {
	return (
		<section className="space-y-1">
			<h4 className="text-sm font-medium">{title}</h4>
			{vehicles.length > 0 && (
				<div className="grid grid-cols-[auto_auto_auto_auto] gap-x-3 text-sm font-light whitespace-nowrap mt-2" role="table">
					<div className="text-right font-medium" role="columnheader">#</div>
					<div className="flex items-center font-medium" role="columnheader">
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger>
									<Info size={16} className="text-blue-400 hover:text-blue-300 cursor-pointer" />
								</TooltipTrigger>
								<TooltipContent>
									Delay/Respawn (in minutes)
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
					<div className="flex items-center font-medium" role="columnheader">
						<Car size={16} className="text-green-400" />
					</div>
					<div className="font-medium" role="columnheader">Vehicle</div>
					{vehicles.map((vehicle, index) => <IndividualVehicleRow key={index} vehicle={vehicle} />)}
				</div>
			)}
		</section>
	)
}

function IndividualVehicleRow({ vehicle }: { vehicle: SLL.Vehicle }) {
	const delayRespawnInfo = `${vehicle.delay}/${vehicle.respawnTime}`

	return (
		<>
			<div className="text-right" role="cell">{vehicle.count}</div>
			<div role="cell">{delayRespawnInfo}</div>
			<div role="cell">{vehicle.vehType}</div>
			<div role="cell">{vehicle.name}</div>
		</>
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
			<div className="text-right" role="cell">{totalCount}</div>
			<div role="cell">{delayRespawnInfo}</div>
			<div role="cell">{vehicle.type}</div>
			<div role="cell">{vehicle.name}</div>
		</>
	)
}

function OtherScoreRow({
	scoreType,
	score,
	scoreRange,
}: {
	scoreType: string
	score: number
	scoreRange?: { min: number; max: number; field: string }
}) {
	// No special color coding for Balance Differential
	const isBalanceDifferential = scoreType === 'Balance_Differential'

	// Calculate percentage based on actual score range
	let percentage = 0
	if (scoreRange) {
		const range = scoreRange.max - scoreRange.min
		const normalizedScore = Math.abs(score - scoreRange.min)
		percentage = range > 0 ? (normalizedScore / range) * 100 : 0
	} else {
		percentage = Math.min(Math.abs(score) * 10, 100)
	}

	return (
		<div className="space-y-1">
			<div className="flex justify-between items-center">
				<span className="text-sm font-medium">{scoreType.replace(/_/g, ' ')}</span>
				<span className="text-xs font-medium text-muted-foreground">
					{score > 0 ? '+' : ''}
					{score.toFixed(2)}
				</span>
			</div>
			<div className="h-1 rounded-full bg-muted">
				<div
					className="h-full rounded-full transition-all duration-200 bg-muted-foreground"
					style={{ width: `${Math.min(percentage, 100)}%` }}
				/>
			</div>
		</div>
	)
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

function ScoreGrid(
	{ scores, layerDetails }: {
		scores: LC.PartitionedScores
		layerDetails?: { layer: L.KnownLayer; team1?: L.FactionUnitConfig; team2?: L.FactionUnitConfig; layerConfig?: L.LayerConfig }
	},
) {
	const scoreTypes = Object.keys(scores.diffs)
	const otherScores = Object.keys(scores.other)

	// Get team roles for headers
	const team1Role = layerDetails?.layerConfig?.teams[0]?.role
	const team2Role = layerDetails?.layerConfig?.teams[1]?.role
	const team1RoleText = team1Role ? ` (${team1Role})` : ''
	const team2RoleText = team2Role ? ` (${team2Role})` : ''

	return (
		<div className="grid gap-2">
			{scoreTypes.length > 0 && (
				<div className="flex justify-between items-center mb-2 text-xs text-muted-foreground">
					<span>Team 1 ({layerDetails?.layer.Faction_1}){team1RoleText}</span>
					<span>Team 2 ({layerDetails?.layer.Faction_2}){team2RoleText}</span>
				</div>
			)}
			{scoreTypes.map(scoreType => {
				const scoreRange = scoreRanges.paired.find(range => range.field === scoreType)
				return (
					<ScoreRow
						key={scoreType}
						scoreType={scoreType}
						team1Score={scores.team1[scoreType] || 0}
						team2Score={scores.team2[scoreType] || 0}
						diff={scores.diffs[scoreType] || 0}
						scoreRange={scoreRange}
					/>
				)
			})}
			{otherScores.length > 0 && (
				<div className="mt-3 pt-3 border-t border-muted">
					{otherScores.map(scoreType => {
						const scoreRange = scoreRanges.regular.find(range => range.field === scoreType)
						return (
							<OtherScoreRow
								key={scoreType}
								scoreType={scoreType}
								score={scores.other[scoreType] || 0}
								scoreRange={scoreRange}
							/>
						)
					})}
				</div>
			)}
		</div>
	)
}

function ScoreRow({
	scoreType,
	team1Score,
	team2Score,
	diff,
	scoreRange,
}: {
	scoreType: string
	team1Score: number
	team2Score: number
	diff: number
	scoreRange?: { min: number; max: number; field: string }
}) {
	// Use score range for better normalization
	const range = scoreRange ? scoreRange.max - scoreRange.min : Math.max(Math.abs(team1Score), Math.abs(team2Score)) * 2
	const normalizedDiff = range > 0 ? (diff / range) : 0
	const balancePercentage = 50 + (normalizedDiff * 50)

	return (
		<div className="space-y-1">
			<div className="flex justify-between items-center">
				<span className="text-xs text-muted-foreground">
					{team1Score.toFixed(1)}
				</span>
				<span className="text-sm font-medium">{scoreType.replace(/_/g, ' ')}</span>
				<span className="text-xs text-muted-foreground">
					{team2Score.toFixed(1)}
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
