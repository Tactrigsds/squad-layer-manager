import scoreRanges from '$root/assets/score-ranges.json'
import * as AR from '@/app-routes.ts'
import { copyAdminSetNextLayerCommand } from '@/client.helpers/layer-table-helpers.ts'
import * as DH from '@/lib/display-helpers.ts'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import * as SLL from '@/models/squad-layer-list.models'
import * as AppRoutesClient from '@/systems.client/app-routes.client'
import * as ConfigClient from '@/systems.client/config.client'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React, { useRef, useState } from 'react'
import MapLayerDisplay from './map-layer-display.tsx'
import { Button, buttonVariants } from './ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'
import TabsList from './ui/tabs-list.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

type LayerInfoProps = {
	// expected to be known layer id
	layerId: L.LayerId
	children: React.ReactNode
}

type LayerInfoContentProps = {
	// expected to be known layer id
	layerId: L.LayerId
	hidePopoutButton?: boolean
	close?: () => void
}

export default function LayerInfoDialog(props: LayerInfoProps) {
	const isKnownLayer = L.isKnownLayer(L.toLayer(props.layerId))
	const [open, setOpen] = React.useState(false)
	if (!isKnownLayer) return null

	return (
		<Popover modal={true} open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				{props.children}
			</PopoverTrigger>
			<PopoverContent align="center" className="w-max">
				<LayerInfo layerId={props.layerId} close={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	)
}

export function LayerInfoPage() {
	const params = AppRoutesClient.useAppParams('/layers/:id')
	const isKnownLayer = L.isKnownLayer(params.id)
	if (!isKnownLayer) return null
	return (
		<div className="p-4">
			<LayerInfo hidePopoutButton={true} layerId={params.id} />
		</div>
	)
}

function LayerInfo(props: LayerInfoContentProps) {
	const [activeTab, setActiveTab] = useState<'details' | 'scores'>('details')
	const contentRef = useRef<HTMLDivElement>(null)
	const layerRes = useQuery(LayerQueriesClient.getLayerInfoQueryOptions(props.layerId))
	const cfg = ConfigClient.useEffectiveColConfig()
	let squadcalcUrl: string | undefined
	{
		const config = ConfigClient.useConfig()
		const layer = L.toLayer(props.layerId)
		if (config && layer.Gamemode && layer.Map) {
			const params = new URLSearchParams()
			params.set('map', layer.Map)
			params.set('layer', layer.Gamemode.replace('FRAAS', 'RAAS') + (layer.LayerVersion ? layer.LayerVersion.toLowerCase() : ''))
			squadcalcUrl = config.PUBLIC_SQUADCALC_URL + '?' + params.toString()
		}
	}
	let scores: LC.PartitionedScores | undefined
	const layerDetails = React.useMemo(() => {
		const layer = L.toLayer(props.layerId)!
		if (!L.isKnownLayer(layer)) throw new Error(`Layer ${props.layerId} is not a known layer`)
		const layerDetails = L.resolveLayerDetails(layer)
		return layerDetails
	}, [props.layerId])

	if (layerRes.data && cfg) {
		const layer = layerRes.data as L.KnownLayer
		scores = LC.partitionScores(layer, cfg)
	}
	const openInPopoutWindow = () => {
		let width = 650
		let height = 450

		if (contentRef.current) {
			const rect = contentRef.current.getBoundingClientRect()
			// Add some padding to account for browser chrome and scrollbars
			width = Math.max(Math.min(rect.width + 40, window.screen.width * 0.8), 400)
			height = Math.max(Math.min(rect.height + 80, window.screen.height * 0.8), 300)
		}

		window.open(AR.link('/layers/:id', props.layerId), '_blank', `popup=yes,height=${height},width=${width},scrollbars=yes,resizable=yes`)
		props.close?.()
	}

	const hasScores = scores && Object.values(scores).some(type => Object.values(type).some(score => typeof score === 'number'))
	return (
		<div ref={contentRef} className="space-y-3">
			<div className="flex justify-between items-center space-x-2">
				<div className="flex items-center gap-3">
					<MapLayerDisplay layer={L.toLayer(props.layerId).Layer} extraLayerStyles={undefined} />
					<Button
						onClick={() => copyAdminSetNextLayerCommand([props.layerId])}
						size="icon"
						variant="ghost"
						title="Copy AdminSetNextLayer command"
					>
						<Icons.Clipboard />
					</Button>
					{!props.hidePopoutButton && (
						<Button
							onClick={openInPopoutWindow}
							size="icon"
							variant="ghost"
							title="Open in popout window"
						>
							<Icons.ExternalLink />
						</Button>
					)}
					<a className={buttonVariants({ variant: 'ghost', size: 'icon' })} title="Open in SquadCalc" href={squadcalcUrl} target="_blank">
						<Icons.Map />
					</a>
					{layerDetails?.layerConfig && <LayerConfigInfo layerConfig={layerDetails.layerConfig} />}
				</div>
				<TabsList
					options={[
						{ value: 'details', label: 'Details' },
						{ value: 'scores', label: 'Scores', disabled: !hasScores && 'Scores are not available for this layer' },
					]}
					active={activeTab}
					setActive={setActiveTab}
				/>
			</div>
			{activeTab === 'details' && layerDetails && <LayerDetailsDisplay layerDetails={layerDetails} />}
			{activeTab === 'details' && !layerDetails && <div>No details available</div>}
			{activeTab === 'scores' && scores && layerDetails && <ScoreGrid scores={scores} layerDetails={layerDetails} />}
			{activeTab === 'scores' && !scores && <div>No scores available</div>}
		</div>
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
				<strong>{title}{role && ` (${role})`}</strong> - {faction} ({unit?.type || 'Unknown'})
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
									<Icons.Info size={16} className="text-blue-400 hover:text-blue-300 cursor-pointer" />
								</TooltipTrigger>
								<TooltipContent>
									Delay/Respawn (in minutes)
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
					<div className="flex items-center font-medium" role="columnheader">
						<Tooltip>
							<TooltipTrigger>
								<Icons.Car size={16} className="text-green-400" />
							</TooltipTrigger>
							<TooltipContent>
								Vehicle Type
							</TooltipContent>
						</Tooltip>
					</div>
					<div className="font-medium" role="columnheader">Name</div>
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

function OtherScoreRow({
	scoreType,
	score,
	scoreRange,
}: {
	scoreType: string
	score: number
	scoreRange?: { min: number; max: number; field: string }
}) {
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
	// List of scores that are NOT z-scores
	const nonZScores = ['ZERO_Score', 'Balance_Differential']

	// Separate z-scores from non-z-scores in diffs
	const zScoreTypes = Object.keys(scores.diffs).filter(score => !nonZScores.includes(score)).sort()
	const diffNonZScores = Object.keys(scores.diffs).filter(score => nonZScores.includes(score) && score !== 'Balance_Differential')
	const otherScores = Object.keys(scores.other)

	// Get team roles for headers
	const team1Role = layerDetails?.layerConfig?.teams[0]?.role
	const team2Role = layerDetails?.layerConfig?.teams[1]?.role
	const team1RoleText = team1Role ? ` (${team1Role})` : ''
	const team2RoleText = team2Role ? ` (${team2Role})` : ''

	return (
		<div className="grid gap-2">
			{zScoreTypes.length > 0 && (
				<div className="flex justify-between items-center mb-2 text-xs">
					<span className="text-blue-500 font-medium">Team 1 ({layerDetails?.layer.Faction_1}){team1RoleText}</span>
					<span className="text-red-500 font-medium">Team 2 ({layerDetails?.layer.Faction_2}){team2RoleText}</span>
				</div>
			)}
			{zScoreTypes.map((scoreType, index) => {
				return (
					<div key={scoreType}>
						{index > 0 && <div className="border-t border-muted/30 my-2" />}
						<ZScoreRow
							scoreType={scoreType}
							team1Score={scores.team1[scoreType]}
							team2Score={scores.team2[scoreType]}
							diff={scores.diffs[scoreType]}
						/>
					</div>
				)
			})}
			{(diffNonZScores.length > 0 || otherScores.length > 0) && (
				<div className="mt-3 pt-3 border-t border-muted space-y-2">
					{diffNonZScores.map(scoreType => {
						const scoreRange = [...scoreRanges.paired, ...scoreRanges.regular].find(range => range.field === scoreType)
						return (
							<DiffScoreRow
								key={scoreType}
								scoreType={scoreType}
								team1Score={scores.team1[scoreType]}
								team2Score={scores.team2[scoreType]}
								diff={scores.diffs[scoreType] || 0}
								scoreRange={scoreRange}
							/>
						)
					})}
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

function ZScoreRow({
	scoreType,
	team1Score,
	team2Score,
	diff,
}: {
	scoreType: string
	team1Score?: number
	team2Score?: number
	diff: number
}) {
	// Z-scores typically range from -3 to 3 (covering 99.7% of data)
	const Z_MIN = -3
	const Z_MAX = 3
	const Z_RANGE = Z_MAX - Z_MIN

	// Convert z-score to percentage position on the scale (0-100%)
	const getPosition = (score: number | undefined): number => {
		if (score === undefined) return 50
		// Clamp to visible range
		const clampedScore = Math.max(Z_MIN, Math.min(Z_MAX, score))
		return ((clampedScore - Z_MIN) / Z_RANGE) * 100
	}

	const team1Position = getPosition(team1Score)
	const team2Position = getPosition(team2Score)

	// Standard deviation markers
	const stdMarkers = [-3, -2, -1, 0, 1, 2, 3]

	return (
		<div className="space-y-2">
			<div className="flex justify-between items-center">
				<span className="text-xs text-muted-foreground">
					{team1Score !== undefined ? team1Score.toFixed(2) : 'N/A'}
				</span>
				<span className="text-sm font-medium">
					{scoreType.replace(/_/g, ' ')}{' '}
					<span className={`text-xs ${diff > 0 ? 'text-blue-500' : diff < 0 ? 'text-red-500' : 'text-muted-foreground'}`}>
						({Math.abs(diff).toFixed(2)})
					</span>
				</span>
				<span className="text-xs text-muted-foreground">
					{team2Score !== undefined ? team2Score.toFixed(2) : 'N/A'}
				</span>
			</div>

			{/* SVG visualization */}
			<svg width="100%" height="48" className="overflow-visible">
				{/* Main axis line */}
				<line
					x1="0"
					y1="24"
					x2="100%"
					y2="24"
					stroke="currentColor"
					strokeWidth="2"
					className="text-muted"
				/>

				{/* Standard deviation markers */}
				{stdMarkers.map(marker => {
					const position = ((marker - Z_MIN) / Z_RANGE) * 100
					const isZero = marker === 0
					return (
						<g key={marker}>
							<line
								x1={`${position}%`}
								y1={isZero ? '16' : '20'}
								x2={`${position}%`}
								y2={isZero ? '32' : '28'}
								stroke="currentColor"
								strokeWidth={isZero ? '2' : '1'}
								className={isZero ? 'text-foreground/40' : 'text-muted-foreground/30'}
							/>
							<text
								x={`${position}%`}
								y="42"
								textAnchor="middle"
								fontSize="10"
								className="fill-muted-foreground/50"
							>
								{marker}
							</text>
						</g>
					)
				})}

				{/* Team 1 score marker (blue) */}
				{team1Score !== undefined && (
					<g>
						<line
							x1={`${team1Position}%`}
							y1="8"
							x2={`${team1Position}%`}
							y2="24"
							stroke="currentColor"
							strokeWidth="3"
							className="text-blue-500"
							strokeLinecap="round"
						/>
						<circle
							cx={`${team1Position}%`}
							cy="8"
							r="4"
							fill="currentColor"
							className="text-blue-500"
						/>
					</g>
				)}

				{/* Team 2 score marker (red) */}
				{team2Score !== undefined && (
					<g>
						<line
							x1={`${team2Position}%`}
							y1="24"
							x2={`${team2Position}%`}
							y2="40"
							stroke="currentColor"
							strokeWidth="3"
							className="text-red-500"
							strokeLinecap="round"
						/>
						<circle
							cx={`${team2Position}%`}
							cy="40"
							r="4"
							fill="currentColor"
							className="text-red-500"
						/>
					</g>
				)}
			</svg>
		</div>
	)
}

function DiffScoreRow({
	scoreType,
	team1Score,
	team2Score,
	diff,
	scoreRange,
}: {
	scoreType: string
	team1Score?: number
	team2Score?: number
	diff: number
	scoreRange?: { min: number; max: number; field: string }
}) {
	// Calculate percentage based on actual score range
	let balancePercentage = 50
	if (scoreRange) {
		const range = scoreRange.max - scoreRange.min
		const normalizedDiff = range > 0 ? (diff / range) : 0
		balancePercentage = 50 + (normalizedDiff * 50)
	} else {
		// Fallback if no score range available
		balancePercentage = 50 + (diff * 10)
	}

	return (
		<div className="space-y-1">
			<div className="flex justify-between items-center">
				<span className="text-xs text-muted-foreground">
					{team1Score !== undefined ? team1Score.toFixed(2) : 'N/A'}
				</span>
				<span className="text-sm font-medium">{scoreType.replace(/_/g, ' ')}</span>
				<span className="text-xs text-muted-foreground">
					{team2Score !== undefined ? team2Score.toFixed(2) : 'N/A'}
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
