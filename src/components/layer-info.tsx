import scoreRanges from '$root/assets/score-ranges.json'
import { copyAdminSetNextLayerCommand } from '@/helpers.client/layer-table.helpers.ts'
import * as DH from '@/lib/display-helpers.ts'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import type * as SLL from '@/models/squad-layer-list.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as LayerInfoDialogClient from '@/systems.client/layer-info-dialog'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import { useQuery } from '@tanstack/react-query'
import { useLinkProps } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React, { useRef } from 'react'
import MapLayerDisplay from './map-layer-display.tsx'
import { Button, buttonVariants } from './ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog.tsx'
import { Spinner } from './ui/spinner.tsx'
import TabsList from './ui/tabs-list.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

type LayerInfoProps = {
	// expected to be known layer id
	layerId: L.LayerId
	children: React.ReactNode
}

type Tab = LayerInfoDialogClient.Tab

type LayerInfoContentProps = {
	// expected to be known layer id
	layerId: L.LayerId
	tab: Tab
	setTab: (tab: Tab) => void
	hidePopoutButton?: boolean
	close?: () => void
}

export default function LayerInfoDialog(props: LayerInfoProps) {
	const isKnownLayer = L.isKnownLayer(L.toLayer(props.layerId))
	const [tab, setTab] = LayerInfoDialogClient.useActiveTab()
	const [open, setOpen] = React.useState(false)
	if (!isKnownLayer) return null

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{props.children}
			</DialogTrigger>
			<DialogContent className="w-auto max-w-full overflow-x-auto overflow-y-auto max-h-screen min-w-0 p-8">
				<DialogTitle className="hidden">Layer Info</DialogTitle>
				<DialogDescription className="hidden">Layer Info for {DH.displayLayer(props.layerId)}</DialogDescription>
				<LayerInfo layerId={props.layerId} tab={tab || 'details'} setTab={setTab} close={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	)
}

export function LayerInfo(props: LayerInfoContentProps) {
	const activeTab = props.tab
	const setActiveTab = props.setTab
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
	const { href } = useLinkProps({ to: '/layers/$layerId/$tab', params: { layerId: props.layerId, tab: activeTab } })
	const openInPopoutWindow = () => {
		let width = 650
		let height = 450

		if (contentRef.current) {
			const rect = contentRef.current.getBoundingClientRect()
			// Add some padding to account for browser chrome and scrollbars
			width = Math.max(Math.min(rect.width + 40, window.screen.width * 0.8), 400)
			height = Math.max(Math.min(rect.height + 80, window.screen.height * 0.8), 300)
		}

		window.open(href, '_blank', `popup=yes,height=${height},width=${width},scrollbars=yes,resizable=yes`)
		props.close?.()
	}

	const hasScores = scores && Object.values(scores).some(type => Object.values(type).some(score => typeof score === 'number'))
	if (layerRes.isLoading) {
		return (
			<div className="w-full h-full grid place-items-center">
				<Spinner className="w-16 h-16" />
			</div>
		)
	}

	if (!hasScores && activeTab === 'scores') {
		setActiveTab('details')
	}

	return (
		<div
			ref={contentRef}
			className="space-y-3 data-[tab=scores]:max-w-[800px] data-[tab=details]:max-w-[800px] mx-auto"
			data-tab={activeTab}
		>
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
			{activeTab === 'scores' && hasScores && scores && layerDetails && <ScoreGrid scores={scores} layerDetails={layerDetails} />}
			{activeTab === 'scores' && !hasScores && <div>No scores available</div>}
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
						{unit.characteristics.map((char) => <li key={char.description} className="list-disc">{char.description}</li>)}
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
					{vehicles.map((vehicle) => <IndividualVehicleRow key={vehicle.name} vehicle={vehicle} />)}
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
	scoreRange?: { min: number; max: number; field: string; poolCutoff?: number; logarithmic?: boolean }
}) {
	// Helper function to convert value to logarithmic scale
	const getLogPercentage = (value: number, min: number, max: number): number => {
		const logMin = Math.log(min)
		const logMax = Math.log(max)
		const logValue = Math.log(value)
		return ((logValue - logMin) / (logMax - logMin)) * 100
	}

	// Calculate percentage based on actual score range
	let percentage = 0
	if (scoreRange) {
		if (scoreRange.logarithmic) {
			percentage = getLogPercentage(Math.max(score, scoreRange.min), scoreRange.min, scoreRange.max)
		} else {
			const range = scoreRange.max - scoreRange.min
			const normalizedScore = Math.abs(score - scoreRange.min)
			percentage = range > 0 ? (normalizedScore / range) * 100 : 0
		}
	} else {
		percentage = Math.min(Math.abs(score) * 10, 100)
	}

	// Calculate pool cutoff position if it exists
	let cutoffPercentage = 0
	if (scoreRange && scoreRange.poolCutoff !== undefined) {
		if (scoreRange.logarithmic) {
			cutoffPercentage = getLogPercentage(scoreRange.poolCutoff, scoreRange.min, scoreRange.max)
		} else {
			const range = scoreRange.max - scoreRange.min
			const normalizedCutoff = scoreRange.poolCutoff - scoreRange.min
			cutoffPercentage = range > 0 ? (normalizedCutoff / range) * 100 : 0
		}
	}

	return (
		<div className="space-y-1">
			<div className="flex justify-center items-center">
				<span className="text-sm font-medium">
					{scoreType.replace(/_/g, ' ')}{' '}
					<span className="text-xs text-muted-foreground">
						({score > 0 ? '+' : ''}
						{score.toFixed(2)})
					</span>
					{scoreRange?.logarithmic && (
						<>
							{' '}
							<span className="text-xs text-muted-foreground">(logarithmic scale)</span>
						</>
					)}
				</span>
			</div>
			{scoreRange && scoreRange.poolCutoff !== undefined
				? (
					<div className="space-y-1">
						<svg width="100%" height="56" className="overflow-visible">
							{/* Background bar */}
							<rect
								x="0"
								y="4"
								width="100%"
								height="8"
								rx="4"
								fill="currentColor"
								className="text-muted"
							/>
							{/* Score bar */}
							<rect
								x="0"
								y="4"
								width={`${Math.min(percentage, 100)}%`}
								height="8"
								rx="4"
								fill="currentColor"
								className="text-muted-foreground transition-all duration-200"
							/>

							{/* Scale markers */}
							{scoreRange.logarithmic
								? (
									(() => {
										const logMin = Math.log(scoreRange.min)
										const logMax = Math.log(scoreRange.max)
										// Generate tick marks at reasonable intervals for log scale
										const tickValues = [1, 2, 5, 10, 20, 30]
											.filter(v => v >= scoreRange.min && v <= scoreRange.max)

										return tickValues.map(tickValue => {
											const tickPercentage = ((Math.log(tickValue) - logMin) / (logMax - logMin)) * 100
											return (
												<g key={tickValue}>
													<line
														x1={`${tickPercentage}%`}
														y1="20"
														x2={`${tickPercentage}%`}
														y2="28"
														stroke="currentColor"
														strokeWidth="1"
														className="text-muted-foreground/30"
													/>
													<text
														x={`${tickPercentage}%`}
														y="48"
														textAnchor="middle"
														fontSize="9"
														className="fill-muted-foreground/50"
													>
														{tickValue}
													</text>
												</g>
											)
										})
									})()
								)
								: (
									(() => {
										// Linear scale markers
										// Target approximately 1 marking per 50px (assuming typical chart width of ~300-500px)
										const range = scoreRange.max - scoreRange.min
										const targetMarkingCount = Math.max(2, Math.floor(400 / 50)) // Assume ~400px width, minimum 2 markings

										// Calculate step size to get whole numbers
										const idealStep = range / targetMarkingCount
										let step = Math.max(1, Math.round(idealStep))

										// Round step to nice numbers (1, 2, 5, 10, 20, 50, etc.)
										if (step > 1) {
											const magnitude = Math.pow(10, Math.floor(Math.log10(step)))
											const normalized = step / magnitude
											if (normalized <= 1) step = magnitude
											else if (normalized <= 2) step = 2 * magnitude
											else if (normalized <= 5) step = 5 * magnitude
											else step = 10 * magnitude
										}

										const tickValues: number[] = []
										const startValue = Math.ceil(scoreRange.min / step) * step

										for (let value = startValue; value <= scoreRange.max; value += step) {
											tickValues.push(value)
										}

										// Always include min and max values
										if (!tickValues.includes(scoreRange.min)) {
											tickValues.unshift(scoreRange.min)
										}
										if (!tickValues.includes(scoreRange.max)) {
											tickValues.push(scoreRange.max)
										}

										// Determine if min/max are whole numbers
										const minIsWhole = Number.isInteger(scoreRange.min)
										const maxIsWhole = Number.isInteger(scoreRange.max)
										const useDecimals = minIsWhole && maxIsWhole

										return tickValues.map(tickValue => {
											const tickPercentage = ((tickValue - scoreRange.min) / range) * 100
											// Format: if using decimals and this is a whole number, show 1 decimal, otherwise show 2
											let label: string
											if (Number.isInteger(tickValue)) {
												label = useDecimals ? tickValue.toFixed(1) : tickValue.toString()
											} else {
												label = tickValue.toFixed(2)
											}

											return (
												<g key={tickValue}>
													<line
														x1={`${tickPercentage}%`}
														y1="20"
														x2={`${tickPercentage}%`}
														y2="28"
														stroke="currentColor"
														strokeWidth="1"
														className="text-muted-foreground/30"
													/>
													<text
														x={`${tickPercentage}%`}
														y="48"
														textAnchor="middle"
														fontSize="9"
														className="fill-muted-foreground/50"
													>
														{label}
													</text>
												</g>
											)
										})
									})()
								)}

							{/* Pool cutoff line */}
							<line
								x1={`${cutoffPercentage}%`}
								y1="0"
								x2={`${cutoffPercentage}%`}
								y2="16"
								stroke="white"
								strokeWidth="2"
							/>
							{/* Pool cutoff label */}
							<text
								x={`${cutoffPercentage}%`}
								y="32"
								textAnchor="middle"
								fontSize="10"
								fill="white"
								className="font-medium"
							>
								Pool Cutoff ({scoreRange.poolCutoff})
							</text>
						</svg>
					</div>
				)
				: (
					<div className="h-1 rounded-full bg-muted">
						<div
							className="h-full rounded-full transition-all duration-200 bg-muted-foreground"
							style={{ width: `${Math.min(percentage, 100)}%` }}
						/>
					</div>
				)}
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

function BalanceDifferentialRow({
	diff,
	scoreRange,
}: {
	diff: number
	scoreRange?: { min: number; max: number; field: string; poolCutoff?: number }
}) {
	// Helper function to convert value to logarithmic scale for symmetric centered display
	// Maps values from [min, max] to [0, 100] using log scale centered at 0
	const getLogPercentageSymmetric = (value: number, min: number, max: number): number => {
		// For a symmetric scale centered at 0, we need to handle positive and negative separately
		// Scale range should be symmetric (e.g., -30 to +30)
		const maxAbs = Math.max(Math.abs(min), Math.abs(max))

		if (value === 0) return 50

		// Use log scale for the absolute value, then map to appropriate side
		const absValue = Math.abs(value)
		const logValue = Math.log(absValue + 1) // +1 to handle log(0)
		const logMax = Math.log(maxAbs + 1)

		// Map to 0-50 range, then offset based on sign
		const halfRangePercentage = (logValue / logMax) * 50

		// Positive values go left (inverted), negative values go right
		return value > 0 ? 50 - halfRangePercentage : 50 + halfRangePercentage
	}

	// Calculate percentage based on actual score range using logarithmic scale
	// For Balance_Differential, 0 is centered, negative means Team 2 advantage, positive means Team 1 advantage
	// Invert so positive (Team 1) goes LEFT and negative (Team 2) goes RIGHT
	let diffPercentage = 50
	if (scoreRange) {
		diffPercentage = getLogPercentageSymmetric(diff, scoreRange.min, scoreRange.max)
	} else {
		// Fallback: assume range of -30 to 30
		diffPercentage = getLogPercentageSymmetric(diff, -30, 30)
	}

	// Calculate pool cutoff positions if they exist using logarithmic scale
	// The cutoff represents the maximum acceptable absolute differential (both positive and negative)
	// Inverted: positive cutoff (Team 1) on LEFT, negative cutoff (Team 2) on RIGHT
	let poolCutoffPositivePercentage = 0
	let poolCutoffNegativePercentage = 0
	if (scoreRange && scoreRange.poolCutoff !== undefined) {
		// Positive cutoff (Team 1 advantage) - inverted so it's on the left
		poolCutoffPositivePercentage = getLogPercentageSymmetric(scoreRange.poolCutoff, scoreRange.min, scoreRange.max)
		// Negative cutoff (Team 2 advantage) - inverted so it's on the right
		poolCutoffNegativePercentage = getLogPercentageSymmetric(-scoreRange.poolCutoff, scoreRange.min, scoreRange.max)
	}

	return (
		<div className="space-y-1">
			<div className="flex justify-center items-center">
				<span className="text-sm font-medium">
					Balance Differential{' '}
					<span className={`text-xs ${diff > 0 ? 'text-blue-500' : diff < 0 ? 'text-red-500' : 'text-muted-foreground'}`}>
						({diff > 0 ? '+' : ''}
						{diff.toFixed(2)})
					</span>{' '}
					<span className="text-xs text-muted-foreground">(logarithmic scale)</span>
				</span>
			</div>
			{scoreRange && scoreRange.poolCutoff !== undefined
				? (
					<div className="space-y-1">
						<svg width="100%" height="56" className="overflow-visible">
							{/* Background bar */}
							<rect
								x="0"
								y="4"
								width="100%"
								height="8"
								rx="4"
								fill="currentColor"
								className="text-muted"
							/>

							{/* Differential indicator - show blue extending left if positive (Team 1 advantage), red extending right if negative (Team 2 advantage) */}
							{diff > 0
								? (
									<rect
										x={`${diffPercentage}%`}
										y="4"
										width={`${Math.min(Math.abs(50 - diffPercentage), 50)}%`}
										height="8"
										rx="4"
										fill="currentColor"
										className="text-blue-500 transition-all duration-200"
									/>
								)
								: diff < 0
								? (
									<rect
										x="50%"
										y="4"
										width={`${Math.min(Math.abs(diffPercentage - 50), 50)}%`}
										height="8"
										rx="4"
										fill="currentColor"
										className="text-red-500 transition-all duration-200"
									/>
								)
								: null}

							{/* Scale markers - logarithmic */}
							{scoreRange && (() => {
								const markers = []
								const maxAbs = Math.max(Math.abs(scoreRange.min), Math.abs(scoreRange.max))

								// Generate logarithmically spaced markers
								// Common intervals: 0, ±1, ±2, ±5, ±10, ±20, ±30, etc.
								const tickValues = [0, 1, 2, 5, 10, 20, 30]
									.filter(v => v <= maxAbs)

								// Add positive values (going left from center)
								for (const value of tickValues) {
									if (value === 0) {
										markers.push({ value: 0, position: 50, isCenter: true })
									} else if (value <= maxAbs) {
										const position = getLogPercentageSymmetric(value, scoreRange.min, scoreRange.max)
										markers.push({ value, position, isCenter: false })
										// Add corresponding negative value (going right from center)
										const negPosition = getLogPercentageSymmetric(-value, scoreRange.min, scoreRange.max)
										markers.push({ value: -value, position: negPosition, isCenter: false })
									}
								}

								return markers.map(({ value, position, isCenter }) => (
									<g key={value}>
										<line
											x1={`${position}%`}
											y1={isCenter ? '16' : '20'}
											x2={`${position}%`}
											y2={isCenter ? '32' : '28'}
											stroke="currentColor"
											strokeWidth={isCenter ? '2' : '1'}
											className={isCenter ? 'text-foreground/40' : 'text-muted-foreground/30'}
										/>
										<text
											x={`${position}%`}
											y="48"
											textAnchor="middle"
											fontSize="9"
											className="fill-muted-foreground/50"
										>
											{value > 0 ? `+${value}` : value}
										</text>
									</g>
								))
							})()}

							{/* Positive pool cutoff line */}
							<line
								x1={`${poolCutoffPositivePercentage}%`}
								y1="0"
								x2={`${poolCutoffPositivePercentage}%`}
								y2="16"
								stroke="white"
								strokeWidth="2"
							/>
							{/* Positive pool cutoff label */}
							<text
								x={`${poolCutoffPositivePercentage}%`}
								y="32"
								textAnchor="middle"
								fontSize="10"
								fill="white"
								className="font-medium"
							>
								Pool Cutoff (+{scoreRange.poolCutoff})
							</text>

							{/* Negative pool cutoff line */}
							<line
								x1={`${poolCutoffNegativePercentage}%`}
								y1="0"
								x2={`${poolCutoffNegativePercentage}%`}
								y2="16"
								stroke="white"
								strokeWidth="2"
							/>
							{/* Negative pool cutoff label */}
							<text
								x={`${poolCutoffNegativePercentage}%`}
								y="32"
								textAnchor="middle"
								fontSize="10"
								fill="white"
								className="font-medium"
							>
								Pool Cutoff (-{scoreRange.poolCutoff})
							</text>

							{/* Current value indicator */}
							<circle
								cx={`${diffPercentage}%`}
								cy="8"
								r="5"
								fill="currentColor"
								className={diff > 0 ? 'text-blue-400' : diff < 0 ? 'text-red-400' : 'text-muted-foreground'}
							/>
						</svg>
					</div>
				)
				: (
					<div className="h-1 rounded-full bg-muted">
						<div
							className="h-full rounded-full transition-all duration-200 bg-muted-foreground"
							style={{ width: `${Math.min(Math.abs(diffPercentage - 50), 50)}%`, marginLeft: diff >= 0 ? '50%' : `${diffPercentage}%` }}
						/>
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
	// Only render dimensions defined in score-ranges.json paired section
	const pairedFields = new Set(scoreRanges.paired.map(range => range.field))
	const zScoreTypes = Object.keys(scores.diffs)
		.filter(score => score !== 'Balance_Differential' && pairedFields.has(score))
		.sort()
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
					<div className="text-blue-500 font-medium">
						<strong>Team 1{team1RoleText}</strong> - {layerDetails?.layer.Faction_1} {layerDetails?.layer.Unit_1}
					</div>
					<div className="text-red-500 font-medium">
						<strong>Team 2{team2RoleText}</strong> - {layerDetails?.layer.Faction_2} {layerDetails?.layer.Unit_2}
					</div>
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
			{(otherScores.length > 0 || scores.diffs['Balance_Differential'] !== undefined) && (
				<div className="mt-3 pt-3 border-t border-muted space-y-2">
					{scores.diffs['Balance_Differential'] !== undefined && (
						<BalanceDifferentialRow
							diff={scores.diffs['Balance_Differential']}
							scoreRange={scoreRanges.regular.find(range => range.field === 'Balance_Differential') as {
								min: number
								max: number
								field: string
								poolCutoff?: number
							} | undefined}
						/>
					)}
					{otherScores.map(scoreType => {
						const scoreRange = scoreRanges.regular.find(range => range.field === scoreType) as {
							min: number
							max: number
							field: string
							poolCutoff?: number
							logarithmic?: boolean
						} | undefined
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
				<span className="text-xs text-blue-500">
					{team1Score !== undefined ? team1Score.toFixed(2) : 'N/A'}
				</span>
				<span className="text-sm font-medium">
					{scoreType.replace(/_/g, ' ')}
					<span className="text-xs font-light">
						<span className="font-light">(diff:{' '}</span>
						<span className={diff > 0 ? 'text-blue-500' : diff < 0 ? 'text-red-500' : 'text-muted-foreground'}>
							{Math.abs(diff).toFixed(2)}
						</span>)
					</span>
				</span>
				<span className="text-xs text-red-500">
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
