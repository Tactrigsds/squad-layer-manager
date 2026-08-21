import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React, { useRef } from 'react'

import scoreRanges from '$root/assets/score-ranges.json'
import { copyAdminSetNextLayerCommand } from '@/client.helpers/layer-table-helpers'
import * as DH from '@/lib/display-helpers.ts'
import { useState_withGlobalHandle } from '@/lib/use-state-with-global-handle'
import * as Zus from '@/lib/zustand'
import * as LC_Msgs from '@/messages/layer-columns.messages'
import * as L_Msgs from '@/messages/layer.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns.ts'
import type * as SLL from '@/models/squad-layer-list.models'
import * as TUT from '@/models/tutorial.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import type * as LayerInfoDialogClient from '@/systems/layer-info-dialog.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'

import { type LayerInfoWindowProps, pairedScoreDimensions } from './layer-info-window.helpers'
import MapLayerDisplay from './map-layer-display.tsx'
import { Button, buttonVariants } from './ui/button.tsx'
import {
	DraggableWindowClose,
	DraggableWindowDragBar,
	DraggableWindowPinToggle,
	DraggableWindowTitle,
	OpenWindowInteraction,
} from './ui/draggable-window'
import { Spinner } from './ui/spinner.tsx'
import TabsList from './ui/tabs-list.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import VehicleIcon from './vehicle-icon.tsx'

type LayerInfoProps = {
	// expected to be known layer id
	layerId: L.LayerId
	tab?: LayerInfoDialogClient.Tab
	children: React.ReactNode
}

type Tab = LayerInfoDialogClient.Tab

type LayerInfoContentProps = {
	// expected to be known layer id
	layerId: L.LayerId
	tab: Tab
	setTab: (tab: Tab) => void
	hidePopoutButton?: boolean
	hideTabs?: boolean
	hideLayerName?: boolean
	close?: () => void
}

// Register the draggable window definition
DraggableWindowStore.getState().registerDefinition<LayerInfoWindowProps, unknown>({
	type: WINDOW_ID.enum['layer-info'],
	component: LayerInfoWindow,
	initialPosition: 'above',
	getId: (props) => props.layerId,
	loadAsync: async ({ props }) => {
		await RPC.queryClient.fetchQuery(LayerQueriesClient.getLayerInfoQueryOptions(props.layerId))
	},
})

function LayerInfoTrigger(props: React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }) {
	return <span ref={props.ref} {...props} />
}

export default function LayerInfoDialog(props: LayerInfoProps) {
	const isKnownLayer = L.isKnownLayer(L.toLayer(props.layerId))
	if (!isKnownLayer) return null

	return (
		<OpenWindowInteraction
			windowId={WINDOW_ID.enum['layer-info']}
			windowProps={{ layerId: props.layerId, tab: props.tab }}
			preload="intent"
			render={LayerInfoTrigger}
		>
			{props.children}
		</OpenWindowInteraction>
	)
}

function LayerInfoWindow({ layerId, tab: initialTab }: LayerInfoWindowProps) {
	const [selectedTab, setTab] = useState_withGlobalHandle<LayerInfoDialogClient.Tab>(
		TUT.TOUR_HANDLES.layerInfoTab,
		initialTab || 'details',
	)
	const layerRes = useQuery(LayerQueriesClient.getLayerInfoQueryOptions(layerId))
	const cfg = ConfigClient.useEffectiveColConfig()

	let scores: LC.PartitionedScores | undefined
	if (layerRes.data && cfg) {
		const layer = layerRes.data as L.KnownLayer
		scores = LC.partitionScores(layer, cfg)
	}

	const hasScores = scores && Object.values(scores).some((type) => Object.values(type).some((score) => typeof score === 'number'))

	// the scores tab has nothing to show for a layer without scores, so fall back rather than render it empty
	const tab = !hasScores && selectedTab === 'scores' ? 'details' : selectedTab

	return (
		<div data-tour="layer-details-window" className="min-w-0 min-h-0 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>{DH.displayLayer(layerId)}</DraggableWindowTitle>
				<span data-tour="layer-info-tabs">
					<TabsList
						options={[
							{ value: 'details', label: 'Details' },
							{ value: 'scores', label: 'Scores', disabled: !hasScores && 'Scores are not available for this layer' },
						]}
						active={tab}
						setActive={setTab}
						className="h-7 ml-2"
					/>
				</span>
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="px-3 overflow-auto">
				<LayerInfo layerId={layerId} tab={tab} setTab={setTab} hideTabs hideLayerName />
			</div>
		</div>
	)
}

export function LayerInfo(props: LayerInfoContentProps) {
	const activeTab = props.tab
	const setActiveTab = props.setTab
	const contentRef = useRef<HTMLDivElement>(null)
	const layerRes = useQuery(LayerQueriesClient.getLayerInfoQueryOptions(props.layerId))
	const cfg = ConfigClient.useEffectiveColConfig()
	const squadcalcUrl = Zus.useStore(ConfigClient.Store, (config) =>
		config ? L.getSquadcalcUrl(config.PUBLIC_SQUADCALC_URL, props.layerId) : undefined,
	)
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
	// we aren't using the tanstack router utility functions here because we might be portaled outside of tanstack router context. unsure of how to best deal with this.
	const href = `/layers/${props.layerId}/${activeTab}`
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

	const hasScores = scores && Object.values(scores).some((type) => Object.values(type).some((score) => typeof score === 'number'))
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
			data-tour={activeTab === 'scores' ? 'layer-scores' : 'layer-details'}
			className="space-y-3 data-[tab=scores]:max-w-200 data-[tab=details]:max-w-200 mx-auto"
			data-tab={activeTab}
		>
			<div className="flex justify-between items-center space-x-2">
				<div className="flex items-center gap-3">
					{!props.hideLayerName && <MapLayerDisplay layer={L.toLayer(props.layerId).Layer} extraLayerStyles={undefined} />}
					<Button
						onClick={() => copyAdminSetNextLayerCommand([props.layerId])}
						size="icon"
						variant="ghost"
						title={tr.text(L_Msgs.copySetNextCommand())}
					>
						<Icons.Clipboard />
					</Button>
					{!props.hidePopoutButton && (
						<Button onClick={openInPopoutWindow} size="icon" variant="ghost" title={tr.text(L_Msgs.openInPopoutWindow())}>
							<Icons.ExternalLink />
						</Button>
					)}
					<a
						className={buttonVariants({ variant: 'ghost', size: 'icon' })}
						title={tr.text(L_Msgs.openInSquadCalc())}
						href={squadcalcUrl}
						target="_blank"
					>
						<Icons.Map />
					</a>
					{layerDetails?.layerConfig && <LayerConfigInfo layerConfig={layerDetails.layerConfig} />}
				</div>
				{!props.hideTabs && (
					<TabsList
						options={[
							{ value: 'details', label: tr.text(L_Msgs.detailsTab()) },
							{
								value: 'scores',
								label: tr.text(L_Msgs.scoresTab()),
								disabled: !hasScores && tr.text(L_Msgs.scoresUnavailable()),
							},
						]}
						active={activeTab}
						setActive={setActiveTab}
					/>
				)}
			</div>
			{activeTab === 'details' && layerDetails && <LayerDetailsDisplay layerDetails={layerDetails} />}
			{activeTab === 'details' && !layerDetails && <div>{tr.text(L_Msgs.noDetails())}</div>}
			{activeTab === 'scores' && hasScores && scores && layerDetails && <ScoreGrid scores={scores} layerDetails={layerDetails} />}
			{activeTab === 'scores' && !hasScores && <div>{tr.text(L_Msgs.noScores())}</div>}
		</div>
	)
}

function LayerDetailsDisplay({
	layerDetails,
}: {
	layerDetails: { layer: L.KnownLayer; team1?: L.FactionUnitConfig; team2?: L.FactionUnitConfig; layerConfig?: L.LayerConfig }
}) {
	return (
		<div className="space-y-3 border-b pb-3">
			{/* 2x2 Grid Layout */}
			<div className="grid grid-cols-2 grid-rows-[auto_auto] gap-4">
				{/* Team Info Row */}
				<TeamInfoOnly
					title={tr.text(L_Msgs.team1())}
					unit={layerDetails.team1}
					faction={layerDetails.layer.Faction_1}
					role={layerDetails.layerConfig?.teams[0].role}
					tickets={layerDetails.layerConfig?.teams[0].tickets}
				/>
				<TeamInfoOnly
					title={tr.text(L_Msgs.team2())}
					unit={layerDetails.team2}
					faction={layerDetails.layer.Faction_2}
					role={layerDetails.layerConfig?.teams[1].role}
					tickets={layerDetails.layerConfig?.teams[1].tickets}
				/>

				{/* Vehicles Row */}
				<VehiclesOnly title={tr.text(L_Msgs.team1Vehicles())} unit={layerDetails.team1} />
				<VehiclesOnly title={tr.text(L_Msgs.team2Vehicles())} unit={layerDetails.team2} />
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
				{tr.richText(L_Msgs.teamFactionLine(title, role, faction, unit?.type || tr.text(L_Msgs.unknownUnit())))}
			</div>
			<div className="text-sm font-light">{unit?.displayName || tr.text(L_Msgs.unknownUnit())}</div>
			{tickets && (
				<div className="text-xs text-muted-foreground">
					<strong>{tr.text(L_Msgs.startingTickets())}</strong> {tickets}
				</div>
			)}

			{unit && unit.characteristics && unit.characteristics.length > 0 && (
				<div className="mt-4">
					<ul className="space-y-0.5 text-xs font-light ml-4 mt-2">
						{unit.characteristics.map((char) => (
							<li key={char.description} className="list-disc">
								{char.description}
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	)
}

function VehiclesOnly({ title, unit }: { title: string; unit: L.FactionUnitConfig | undefined }) {
	const vehicles = unit?.vehicles ?? []
	// the class the vehicle filters use, which splits the source's own by running gear and corrects its mislabels
	const types = React.useMemo(() => (unit ? LC.vehicleTypesForUnitRecord(unit) : []), [unit])
	return (
		<section className="space-y-1">
			<h4 className="text-sm font-medium">{title}</h4>
			{vehicles.length > 0 && (
				<div className="grid grid-cols-[auto_auto_auto_auto] gap-x-3 text-sm font-light whitespace-nowrap mt-2" role="table">
					<div className="text-right font-medium" role="columnheader">
						#
					</div>
					<div className="flex items-center font-medium" role="columnheader">
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger>
									<Icons.Timer size={16} className="text-muted-foreground" />
								</TooltipTrigger>
								<TooltipContent>{tr.text(L_Msgs.vehicleDelayRespawn())}</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
					<div className="flex items-center font-medium" role="columnheader">
						<Tooltip>
							<TooltipTrigger>
								<Icons.Car size={16} className="text-muted-foreground" />
							</TooltipTrigger>
							<TooltipContent>{tr.text(L_Msgs.vehicleType())}</TooltipContent>
						</Tooltip>
					</div>
					<div className="font-medium" role="columnheader">
						{tr.text(L_Msgs.vehicleName())}
					</div>
					{vehicles.map((vehicle, index) => (
						<IndividualVehicleRow key={vehicle.name} vehicle={vehicle} type={types[index]} />
					))}
				</div>
			)}
		</section>
	)
}

function IndividualVehicleRow({ vehicle, type }: { vehicle: SLL.Vehicle; type: string | undefined }) {
	const delayRespawnInfo = `${vehicle.delay}/${vehicle.respawnTime}`
	const label = type ? LC_Msgs.vehicleTypeLabels[type] : undefined

	return (
		<>
			<div className="text-right" role="cell">
				{vehicle.count}
			</div>
			<div role="cell">{delayRespawnInfo}</div>
			<div role="cell">
				<Tooltip>
					<TooltipTrigger className="flex items-center gap-1.5">
						<VehicleIcon icon={vehicle.icon} size={18} />
						<span className="font-mono text-xs rounded-sm border px-1 py-px">
							{type ? LC.vehicleTypeShortCode(type) : vehicle.vehType}
						</span>
					</TooltipTrigger>
					<TooltipContent>{label ? tr.text(label) : (type ?? vehicle.vehType)}</TooltipContent>
				</Tooltip>
			</div>
			<div role="cell">{vehicle.name}</div>
		</>
	)
}

// The paired z-scores plot both teams against one axis, so that axis has to be the vertical: left and right
// already mean team 1 and team 2 there. The two gauges below carry a single value each and stay horizontal.
const GAUGE_HEIGHT = 46

type ScoreRange = { min: number; max: number; field: string; poolCutoff?: number; logarithmic?: boolean }

const plotX = (fraction: number) => `${Math.max(0, Math.min(1, fraction)) * 100}%`

function HorizontalGauge({
	ticks,
	cutoffs,
	children,
}: {
	ticks: { fraction: number; label: string; acrossBar?: boolean }[]
	cutoffs: { fraction: number; label: string }[]
	children?: React.ReactNode
}) {
	return (
		<svg width="100%" height={GAUGE_HEIGHT} className="overflow-visible">
			<rect x="0" y="4" width="100%" height="8" rx="4" fill="currentColor" className="text-muted" />
			{ticks.map((tick) => {
				const x = plotX(tick.fraction)
				return (
					<g key={tick.label}>
						<line
							x1={x}
							y1={tick.acrossBar ? '2' : '14'}
							x2={x}
							y2={tick.acrossBar ? '14' : '19'}
							stroke="currentColor"
							strokeWidth={tick.acrossBar ? '2' : '1'}
							className={tick.acrossBar ? 'text-foreground/40' : 'text-muted-foreground/30'}
						/>
						<text x={x} y="29" textAnchor="middle" fontSize="9" className="fill-muted-foreground/50">
							{tick.label}
						</text>
					</g>
				)
			})}
			{children}
			{cutoffs.map((cutoff) => {
				const x = plotX(cutoff.fraction)
				return (
					<g key={cutoff.label}>
						<line x1={x} y1="0" x2={x} y2="16" stroke="white" strokeWidth="2" />
						<text x={x} y="42" textAnchor="middle" fontSize="10" fill="white" className="font-medium">
							{cutoff.label}
						</text>
					</g>
				)
			})}
		</svg>
	)
}

function GaugeCaption({ title, value, logarithmic }: { title: string; value: number; logarithmic?: boolean }) {
	return (
		<figcaption className="text-center text-xs font-medium">
			{title}{' '}
			<span className="text-[10px] font-light text-muted-foreground">
				({value > 0 ? '+' : ''}
				{value.toFixed(2)})
			</span>
			{logarithmic && <span className="text-[10px] font-light text-muted-foreground"> {tr.text(L_Msgs.logarithmicScale())}</span>}
		</figcaption>
	)
}

function niceTickValues(min: number, max: number, targetCount: number): number[] {
	const range = max - min
	if (range <= 0) return [min]
	let step = Math.max(1, Math.round(range / targetCount))
	if (step > 1) {
		const magnitude = Math.pow(10, Math.floor(Math.log10(step)))
		const normalized = step / magnitude
		if (normalized <= 1) step = magnitude
		else if (normalized <= 2) step = 2 * magnitude
		else if (normalized <= 5) step = 5 * magnitude
		else step = 10 * magnitude
	}

	const values: number[] = []
	for (let value = Math.ceil(min / step) * step; value <= max; value += step) values.push(value)
	if (!values.includes(min)) values.unshift(min)
	if (!values.includes(max)) values.push(max)
	return values
}

const tickLabel = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2))

function OtherScoreGauge({ scoreType, score, scoreRange }: { scoreType: string; score: number; scoreRange?: ScoreRange }) {
	const logFraction = (value: number, min: number, max: number) => (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min))

	let fraction: (value: number) => number
	let tickValues: number[]
	if (!scoreRange) {
		fraction = (value) => Math.min(Math.abs(value) * 0.1, 1)
		tickValues = []
	} else if (scoreRange.logarithmic) {
		fraction = (value) => logFraction(Math.max(value, scoreRange.min), scoreRange.min, scoreRange.max)
		tickValues = [1, 2, 5, 10, 20, 30].filter((v) => v >= scoreRange.min && v <= scoreRange.max)
	} else {
		fraction = (value) => (value - scoreRange.min) / (scoreRange.max - scoreRange.min)
		tickValues = niceTickValues(scoreRange.min, scoreRange.max, 8)
	}

	return (
		<figure>
			<GaugeCaption title={scoreType.replace(/_/g, ' ')} value={score} logarithmic={scoreRange?.logarithmic} />
			<HorizontalGauge
				ticks={tickValues.map((value) => ({ fraction: fraction(value), label: tickLabel(value) }))}
				cutoffs={
					scoreRange?.poolCutoff === undefined
						? []
						: [{ fraction: fraction(scoreRange.poolCutoff), label: tr.text(L_Msgs.poolCutoff(String(scoreRange.poolCutoff))) }]
				}
			>
				<rect
					x="0"
					y="4"
					width={plotX(fraction(score))}
					height="8"
					rx="4"
					fill="currentColor"
					className="text-muted-foreground transition-all duration-200"
				/>
			</HorizontalGauge>
		</figure>
	)
}

function LayerConfigInfo({ layerConfig }: { layerConfig: L.LayerConfig }) {
	return (
		<div className="text-xs text-muted-foreground space-y-0.5">
			{!layerConfig.hasCommander && (
				<div>
					<strong>{tr.text(L_Msgs.commanderLabel())}</strong> {tr.text(L_Msgs.commanderDisabled())}
				</div>
			)}
			{layerConfig.persistentLightingType && (
				<div>
					<strong>{tr.text(L_Msgs.lightingLabel())}</strong> {layerConfig.persistentLightingType}
				</div>
			)}
		</div>
	)
}

function BalanceDifferentialGauge({ diff, scoreRange }: { diff: number; scoreRange?: ScoreRange }) {
	const min = scoreRange?.min ?? -30
	const max = scoreRange?.max ?? 30

	// A log scale on the absolute value, mirrored around 0 at the centre. A positive differential favours team 1
	// and runs left, towards the team 1 heading, so the axis agrees with the columns above it.
	const fraction = (value: number) => {
		if (value === 0) return 0.5
		const maxAbs = Math.max(Math.abs(min), Math.abs(max))
		const halfRange = Math.log(Math.abs(value) + 1) / Math.log(maxAbs + 1) / 2
		return value > 0 ? 0.5 - halfRange : 0.5 + halfRange
	}

	const maxAbs = Math.max(Math.abs(min), Math.abs(max))
	const ticks = [0, 1, 2, 5, 10, 20, 30]
		.filter((v) => v <= maxAbs)
		.flatMap((value) =>
			value === 0
				? [{ fraction: 0.5, label: '0', acrossBar: true }]
				: [
						{ fraction: fraction(value), label: `+${value}` },
						{ fraction: fraction(-value), label: `-${value}` },
					],
		)

	const valueX = fraction(diff)

	return (
		<figure>
			<GaugeCaption title={tr.text(L_Msgs.balanceDifferential())} value={diff} logarithmic />
			<HorizontalGauge
				ticks={ticks}
				cutoffs={
					scoreRange?.poolCutoff === undefined
						? []
						: [
								{ fraction: fraction(scoreRange.poolCutoff), label: tr.text(L_Msgs.poolCutoff(`+${scoreRange.poolCutoff}`)) },
								{ fraction: fraction(-scoreRange.poolCutoff), label: tr.text(L_Msgs.poolCutoff(`-${scoreRange.poolCutoff}`)) },
							]
				}
			>
				<rect
					x={plotX(Math.min(0.5, valueX))}
					y="4"
					width={plotX(Math.abs(valueX - 0.5))}
					height="8"
					fill="currentColor"
					className={`transition-all duration-200 ${diff > 0 ? 'text-blue-500' : 'text-red-500'}`}
				/>
				<circle
					cx={plotX(valueX)}
					cy="8"
					r="5"
					fill="currentColor"
					className={diff > 0 ? 'text-blue-400' : diff < 0 ? 'text-red-400' : 'text-muted-foreground'}
				/>
			</HorizontalGauge>
		</figure>
	)
}

function ScoreGrid({
	scores,
	layerDetails,
}: {
	scores: LC.PartitionedScores
	layerDetails?: { layer: L.KnownLayer; team1?: L.FactionUnitConfig; team2?: L.FactionUnitConfig; layerConfig?: L.LayerConfig }
}) {
	const zScoreTypes = pairedScoreDimensions(scores)
	const otherScores = Object.keys(scores.other)

	// Get team roles for headers
	const team1Role = layerDetails?.layerConfig?.teams[0]?.role
	const team2Role = layerDetails?.layerConfig?.teams[1]?.role

	// blue and red mean team 1 and team 2 in every gauge and column below, so the pair is named once, first
	return (
		<div className="grid gap-2">
			<div className="flex justify-between text-xs font-medium">
				<span className="text-blue-500">
					{tr.richText(
						L_Msgs.teamScoreHeading(
							tr.text(L_Msgs.team1()),
							team1Role,
							layerDetails?.layer.Faction_1 ?? '',
							layerDetails?.layer.Unit_1 ?? '',
						),
					)}
				</span>
				<span className="text-red-500">
					{tr.richText(
						L_Msgs.teamScoreHeading(
							tr.text(L_Msgs.team2()),
							team2Role,
							layerDetails?.layer.Faction_2 ?? '',
							layerDetails?.layer.Unit_2 ?? '',
						),
					)}
				</span>
			</div>
			{(otherScores.length > 0 || scores.diffs['Balance_Differential'] !== undefined) && (
				<div className="mb-2 pb-2 border-b border-muted space-y-1">
					{scores.diffs['Balance_Differential'] !== undefined && (
						<div data-tour="layer-score-Balance_Differential">
							<BalanceDifferentialGauge
								diff={scores.diffs['Balance_Differential']}
								scoreRange={scoreRanges.regular.find((range) => range.field === 'Balance_Differential') as ScoreRange | undefined}
							/>
						</div>
					)}
					{otherScores.map((scoreType) => (
						<div key={scoreType} data-tour={`layer-score-${scoreType}`}>
							<OtherScoreGauge
								scoreType={scoreType}
								score={scores.other[scoreType] || 0}
								scoreRange={scoreRanges.regular.find((range) => range.field === scoreType) as ScoreRange | undefined}
							/>
						</div>
					))}
				</div>
			)}
			{zScoreTypes.length > 0 && <ZScoreChart scoreTypes={zScoreTypes} scores={scores} />}
		</div>
	)
}

// Z-scores cover 99.7% of the data within three standard deviations, so the axis is fixed and symmetric rather
// than fitted to the layer: every layer's chart reads at the same scale.
const Z_MIN = -3
const Z_MAX = 3
const Z_HEIGHT = 150
const Z_MARKERS = [3, 2, 1, 0, -1, -2, -3]

// A column is only as wide as the row of numbers under it needs, so the two stems stay close enough together to
// compare. Stretching them across the container is what wastes the space.
const Z_COLUMN_WIDTH = 116

const zY = (score: number) => ((Z_MAX - Math.max(Z_MIN, Math.min(Z_MAX, score))) / (Z_MAX - Z_MIN)) * Z_HEIGHT

// Both teams' markers share one dimension's axis, so the pair can be compared by height rather than by sign.
function ZScoreChart({ scoreTypes, scores }: { scoreTypes: string[]; scores: LC.PartitionedScores }) {
	return (
		// name, chart and numbers are rows of one grid, so a name that wraps in a narrow column moves every
		// column's chart down together rather than leaving a ragged edge
		<div
			data-tour="layer-score-categories"
			className="grid justify-center gap-x-4"
			style={{
				gridTemplateColumns: `auto repeat(${scoreTypes.length}, minmax(0, ${Z_COLUMN_WIDTH}px))`,
				gridTemplateRows: 'auto auto auto',
			}}
		>
			<div />
			{scoreTypes.map((scoreType) => (
				<div key={scoreType} className="mb-0.5 text-center text-xs font-medium leading-tight">
					{scoreType.replace(/_/g, ' ')}
				</div>
			))}
			<svg width="18" height={Z_HEIGHT} className="overflow-visible">
				{Z_MARKERS.map((marker) => (
					<text key={marker} x="18" y={zY(marker)} dy="0.32em" textAnchor="end" fontSize="10" className="fill-muted-foreground/50">
						{marker}
					</text>
				))}
			</svg>
			{scoreTypes.map((scoreType) => (
				<ZScoreColumn key={scoreType} team1Score={scores.team1[scoreType]} team2Score={scores.team2[scoreType]} />
			))}
			<div />
			{scoreTypes.map((scoreType) => (
				<ZScoreValues
					key={scoreType}
					team1Score={scores.team1[scoreType]}
					team2Score={scores.team2[scoreType]}
					diff={scores.diffs[scoreType]}
				/>
			))}
		</div>
	)
}

function ZScoreColumn({ team1Score, team2Score }: { team1Score?: number; team2Score?: number }) {
	return (
		<svg width="100%" height={Z_HEIGHT} className="overflow-visible">
			{Z_MARKERS.map((marker) => {
				const y = zY(marker)
				const isZero = marker === 0
				return (
					<line
						key={marker}
						x1="0"
						y1={y}
						x2="100%"
						y2={y}
						stroke="currentColor"
						strokeWidth={isZero ? '2' : '1'}
						className={isZero ? 'text-foreground/40' : 'text-muted-foreground/20'}
					/>
				)
			})}
			<ZScoreMarker score={team1Score} x="25%" className="text-blue-500" />
			<ZScoreMarker score={team2Score} x="75%" className="text-red-500" />
		</svg>
	)
}

function ZScoreMarker({ score, x, className }: { score?: number; x: string; className: string }) {
	if (score === undefined) return null
	const y = zY(score)
	return (
		<g className={className}>
			<line x1={x} y1={zY(0)} x2={x} y2={y} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
			<circle cx={x} cy={y} r="4" fill="currentColor" />
		</g>
	)
}

function ZScoreValues({ team1Score, team2Score, diff }: { team1Score?: number; team2Score?: number; diff: number }) {
	return (
		<div className="mt-0.5 flex items-baseline justify-between px-0.5 text-[10px] leading-tight">
			<span className="text-blue-500">{team1Score !== undefined ? team1Score.toFixed(2) : tr.text(L_Msgs.scoreUnavailable())}</span>
			<span className="font-light">
				{tr.richText(
					L_Msgs.scoreDiff(
						<span className={diff > 0 ? 'text-blue-500' : diff < 0 ? 'text-red-500' : 'text-muted-foreground'}>
							{Math.abs(diff).toFixed(2)}
						</span>,
					),
				)}
			</span>
			<span className="text-red-500">{team2Score !== undefined ? team2Score.toFixed(2) : tr.text(L_Msgs.scoreUnavailable())}</span>
		</div>
	)
}
