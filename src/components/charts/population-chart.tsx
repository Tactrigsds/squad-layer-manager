import * as React from 'react'

import { TrackingTooltip } from '@/components/ui/tooltip'
import * as Chart from '@/lib/chart'
import { cn } from '@/lib/utils'
import * as Pop from '@/models/population.models'
import type * as StatsModels from '@/models/stats-panel.models'

import { useMeasuredSize } from './measure'

const { active: ACTIVE_COLOR, idleStroke: IDLE_STROKE, total: TOTAL_COLOR } = Pop.COLORS

const AXIS_FONT = 10
const AXIS_HEIGHT = 16
const BAND_LABEL_HEIGHT = 16
const TOP_PAD = 8
const MIN_PLOT = 40
const FLAG = 'l6 3 l-6 3 Z'

/**
 * Players over time, filling its container. `split` stacks active players under idle ones with the total on top, or
 * draws a line per team. Each match is a band: a solid line where it started, flagged and named when there is room,
 * a dashed line where its round ended, and the stretch from round end to the next match darkened. The displayed match
 * is outlined with its start. `show` turns each of these off, and with the active players hidden the idle ones sit
 * on the axis. Hovering shows a crosshair and `renderTooltip` for the bucket under it; clicking selects that band.
 */
export function PopulationChart(props: {
	view: StatsModels.PopulationView
	split: 'activity' | 'teams'
	// the y axis's top when it should hold more than the players drawn, such as the server's player cap
	yMax?: number
	formatX: (time: number) => string
	xTicks: (start: number, end: number, targetTicks: number) => number[]
	// matchStart is off for a single match, whose start is the axis's left edge
	show: { active: boolean; idle: boolean; matchStart: boolean; roundEnd: boolean }
	onSelectBand?: (band: StatsModels.PopulationBand) => void
	renderTooltip: (index: number, band: StatsModels.PopulationBand | undefined) => React.ReactNode
	ariaLabel: string
	className?: string
}) {
	const { view } = props
	const [container, setContainer] = React.useState<HTMLDivElement | null>(null)
	const { width, height } = useMeasuredSize(container)
	const [hover, setHover] = React.useState<number | null>(null)
	const hatchId = React.useId()
	const showBandStarts = props.show.matchStart
	const showRoundEnds = props.show.roundEnd

	let maxY = 0
	const series = props.split === 'activity' ? [view.total] : view.sides
	for (const values of series) for (const v of values) if (v > maxY) maxY = v

	const top = TOP_PAD + (showBandStarts ? BAND_LABEL_HEIGHT : 0)
	const plotHeight = height - AXIS_HEIGHT - top
	const yAxis = Chart.axis(Math.max(maxY, props.yMax ?? 0), Math.max(2, Math.floor(plotHeight / 32)), { integer: true })
	const left = Math.ceil(Math.max(...yAxis.ticks.map((tick) => Chart.estimateNumeralsWidth(String(tick), AXIS_FONT)))) + 6
	const right = 6
	const plotWidth = width - left - right
	const ready = plotWidth >= MIN_PLOT && plotHeight >= MIN_PLOT

	const span = view.end - view.start
	const xToPx = (time: number) => left + Chart.project(Math.min(view.end, Math.max(view.start, time)) - view.start, span, plotWidth)
	const yToPx = (value: number) => top + plotHeight - Chart.project(value, yAxis.max, plotHeight)
	const bucketX = (i: number) => view.start + (i + 0.5) * view.bucketMs
	const bandAt = (time: number) => view.bands.findLast((band) => band.start <= time && time < band.end)

	const line = (values: number[]) =>
		view.runs.map(([from, to]) => {
			let d = ''
			for (let i = from; i < to; i++) d += `${i === from ? 'M' : 'L'}${xToPx(bucketX(i))} ${yToPx(values[i])}`
			return { from, d }
		})
	const area = (upper: number[], lower: number[] | null) =>
		view.runs.map(([from, to]) => {
			let d = ''
			for (let i = from; i < to; i++) d += `${i === from ? 'M' : 'L'}${xToPx(bucketX(i))} ${yToPx(upper[i])}`
			for (let i = to - 1; i >= from; i--) d += `L${xToPx(bucketX(i))} ${yToPx(lower ? lower[i] : 0)}`
			return { from, d: d + 'Z' }
		})

	const indexAt = (e: React.PointerEvent<SVGRectElement> | React.MouseEvent<SVGRectElement>) => {
		const rect = e.currentTarget.getBoundingClientRect()
		const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
		return Math.min(view.total.length - 1, Math.floor((ratio * span) / view.bucketMs))
	}

	const hoverBand = hover === null ? undefined : bandAt(bucketX(hover))
	const tooltip = hover !== null && Number.isFinite(view.total[hover]) ? props.renderTooltip(hover, hoverBand) : null

	let body: React.ReactNode = null
	if (ready) {
		const xTicks = props.xTicks(view.start, view.end, Math.max(2, Math.floor(plotWidth / 80)))
		const bottom = top + plotHeight
		const bandTop = TOP_PAD + (showBandStarts ? BAND_LABEL_HEIGHT - 2 : 0)
		body = (
			<svg width={width} height={height} role="img" aria-label={props.ariaLabel} className="block">
				<defs>
					<pattern id={hatchId} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
						<rect width={5} height={5} fill={ACTIVE_COLOR} fillOpacity={0.15} />
						<line x1={0} y1={0} x2={0} y2={5} stroke={IDLE_STROKE} strokeWidth={1.5} strokeOpacity={0.8} />
					</pattern>
				</defs>
				{view.bands.map(
					(band) =>
						band.displayed &&
						showBandStarts && (
							<g key={`sel-${band.ordinal}`} className="text-pri">
								<rect
									x={xToPx(band.start)}
									y={bandTop}
									width={Math.max(0, xToPx(band.end) - xToPx(band.start))}
									height={bottom - bandTop}
									fill="currentColor"
									fillOpacity={0.07}
								/>
								<rect
									x={xToPx(band.start)}
									y={bandTop}
									width={Math.max(0, xToPx(band.end) - xToPx(band.start))}
									height={3}
									fill="currentColor"
								/>
							</g>
						),
				)}
				<g className="text-line-soft" stroke="currentColor" strokeWidth={1}>
					{yAxis.ticks.map((tick) =>
						tick === 0 ? null : (
							<line
								key={tick}
								x1={left}
								x2={left + plotWidth}
								y1={Math.round(yToPx(tick)) + 0.5}
								y2={Math.round(yToPx(tick)) + 0.5}
							/>
						),
					)}
				</g>
				<g fill="#000000" fillOpacity={0.32}>
					{view.bands.map((band) =>
						!showRoundEnds || band.roundEnd === null || band.roundEnd >= band.end ? null : (
							<rect
								key={`gap-${band.ordinal}`}
								x={xToPx(band.roundEnd)}
								y={bandTop}
								width={Math.max(0, xToPx(band.end) - xToPx(band.roundEnd))}
								height={bottom - bandTop}
							/>
						),
					)}
				</g>
				{props.split === 'activity' ? (
					<>
						{props.show.active &&
							area(view.active, null).map(({ from, d }) => (
								<path key={`active-${from}`} d={d} fill={ACTIVE_COLOR} fillOpacity={0.7} />
							))}
						{props.show.idle &&
							(props.show.active ? area(view.total, view.active) : area(view.idle, null)).map(({ from, d }) => (
								<path key={`idle-${from}`} d={d} fill={`url(#${hatchId})`} />
							))}
						{line(view.total).map(({ from, d }) => (
							<path key={`total-${from}`} d={d} fill="none" stroke={TOTAL_COLOR} strokeWidth={2} strokeLinejoin="round" />
						))}
					</>
				) : (
					view.sides.map((values, s) =>
						line(values).map(({ from, d }) => (
							<path
								key={`side${s}-${from}`}
								d={d}
								fill="none"
								stroke={view.sideDisplays[s].color}
								strokeWidth={2}
								strokeLinejoin="round"
							/>
						)),
					)
				)}
				<g className="text-text-2" stroke="currentColor" strokeWidth={1.5}>
					{view.bands.map((band) =>
						!showRoundEnds || band.roundEnd === null || band.roundEnd < view.start || band.roundEnd > view.end ? null : (
							<line
								key={`end-${band.ordinal}`}
								x1={xToPx(band.roundEnd)}
								x2={xToPx(band.roundEnd)}
								y1={bandTop}
								y2={bottom}
								strokeDasharray="3 3"
							/>
						),
					)}
					{showBandStarts &&
						view.bands.map((band) =>
							band.start < view.start ? null : (
								<line key={`start-${band.ordinal}`} x1={xToPx(band.start)} x2={xToPx(band.start)} y1={bandTop} y2={bottom} />
							),
						)}
				</g>
				{showBandStarts && (
					<g fontSize={AXIS_FONT} className="fill-current text-text-2">
						{view.bands.map((band) => {
							const x = Math.max(left, xToPx(band.start))
							const room = xToPx(band.end) - x - 10
							const fits = room >= band.label.length * AXIS_FONT * 0.55
							return (
								<g key={`label-${band.ordinal}`}>
									{band.start >= view.start && <path d={`M${x} ${bandTop}${FLAG}`} />}
									{fits && (
										<text x={x + 9} y={TOP_PAD + 9} className={cn(band.displayed && 'fill-pri-hi font-bold')}>
											{band.label}
										</text>
									)}
								</g>
							)
						})}
					</g>
				)}
				<line className="text-ctl-hi" stroke="currentColor" x1={left} x2={left + plotWidth} y1={bottom + 0.5} y2={bottom + 0.5} />
				<g className="fill-current text-text-3 font-mono" fontSize={AXIS_FONT}>
					{yAxis.ticks.map((tick) => (
						<text key={tick} x={left - 4} y={yToPx(tick)} textAnchor="end" dominantBaseline="central">
							{tick}
						</text>
					))}
					{xTicks.map((tick) => {
						const x = xToPx(tick)
						const anchor = x < left + 20 ? 'start' : x > left + plotWidth - 20 ? 'end' : 'middle'
						return (
							<text key={tick} x={x} y={height - 3} textAnchor={anchor}>
								{props.formatX(tick)}
							</text>
						)
					})}
				</g>
				{hover !== null && Number.isFinite(view.total[hover]) && (
					<g pointerEvents="none">
						<line
							x1={xToPx(bucketX(hover))}
							x2={xToPx(bucketX(hover))}
							y1={top}
							y2={bottom}
							stroke="currentColor"
							className="text-text"
							strokeOpacity={0.6}
						/>
						{(props.split === 'activity'
							? [
									...(props.show.active ? [{ key: 'active', value: view.active[hover], color: ACTIVE_COLOR }] : []),
									{ key: 'total', value: view.total[hover], color: TOTAL_COLOR },
								]
							: view.sides.map((values, s) => ({ key: `side${s}`, value: values[hover], color: view.sideDisplays[s].color }))
						).map((dot) => (
							<circle
								key={dot.key}
								cx={xToPx(bucketX(hover))}
								cy={yToPx(dot.value)}
								r={4}
								fill={dot.color}
								stroke="var(--panel)"
								strokeWidth={2}
							/>
						))}
					</g>
				)}
				<rect
					x={left}
					y={top}
					width={plotWidth}
					height={plotHeight}
					fill="transparent"
					className={cn(props.onSelectBand && hoverBand && 'cursor-pointer')}
					onPointerMove={(e) => setHover(indexAt(e))}
					onPointerLeave={() => setHover(null)}
					onClick={(e) => {
						const band = bandAt(bucketX(indexAt(e)))
						if (band) props.onSelectBand?.(band)
					}}
				/>
			</svg>
		)
	}

	return (
		<div ref={setContainer} className={cn('relative w-full h-full min-h-0 overflow-hidden', props.className)}>
			{body}
			<TrackingTooltip content={tooltip} />
		</div>
	)
}

/** The legend swatch for idle players, the chart's hatch at legend size. */
export function IdleSwatch() {
	const id = React.useId()
	return (
		<svg width={12} height={10} aria-hidden="true" className="shrink-0">
			<defs>
				<pattern id={id} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
					<rect width={4} height={4} fill={ACTIVE_COLOR} fillOpacity={0.15} />
					<line x1={0} y1={0} x2={0} y2={4} stroke={IDLE_STROKE} strokeWidth={1.5} />
				</pattern>
			</defs>
			<rect width={12} height={10} rx={2} fill={`url(#${id})`} />
		</svg>
	)
}
