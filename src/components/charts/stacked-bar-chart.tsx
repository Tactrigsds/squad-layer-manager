import * as React from 'react'
import { createPortal } from 'react-dom'

import { TrackingTooltip } from '@/components/ui/tracking-tooltip'
import * as Chart from '@/lib/chart'
import { cn } from '@/lib/utils'

const LABEL_SIZE = 11
const ROW_LABEL_HEIGHT = 16
const ROW_GAP = 10
const AXIS_HEIGHT = 16
const DIM_OPACITY = 0.35
const SEGMENT_GAP = 1

/**
 * Horizontal stacked bars, one per row, all sharing an integer value axis: a count of a whole split by category,
 * compared across rows. Hovering a segment or a legend entry dims every other series.
 *
 * `sideBySide` lays two rows out as mirror images on one line, the first growing leftwards from the middle, the
 * way the two teams face each other. The legend can be sent to another element (`legendPortal`) so a panel title
 * bar carries it while the hover dimming still works.
 */
export function StackedBarChart(props: {
	rows: Chart.Row[]
	series: Chart.Series[]
	barHeight?: number
	className?: string
	ariaLabel?: string
	sideBySide?: boolean
	// colour for each row's label, e.g. the team colour
	rowColors?: (string | undefined)[]
	legendPortal?: HTMLElement | null
	renderTooltip?: (datum: Chart.Datum) => React.ReactNode
	renderLegendTooltip?: (seriesIndex: number) => React.ReactNode
	// what the modifiers mean is the caller's to decide; the chart only reports which were held
	onSegmentClick?: (datum: Chart.Datum, modifiers: { shift: boolean; ctrl: boolean }) => void
	// rendered at the start of the legend row, e.g. the chart's title
	legendLeading?: React.ReactNode
	// rendered right after the series swatches, and wraps to its own row together with them when the row is too
	// narrow, rather than leaving legendLeading/legendTrailing stranded next to a half-wrapped legend
	legendExtra?: React.ReactNode
	// rendered at the end of the legend row, e.g. the chart's help affordance
	legendTrailing?: React.ReactNode
}) {
	const barHeight = props.barHeight ?? 18
	const [container, setContainer] = React.useState<HTMLDivElement | null>(null)
	const width = useMeasuredWidth(container)
	const [hovered, setHovered] = React.useState<Chart.Datum | null>(null)
	const [hoveredSeries, setHoveredSeries] = React.useState<number | null>(null)

	const totals = props.rows.map((row) => Chart.total(row.values))
	const axis = Chart.axis(Math.max(...totals, 0), 4, { integer: true })
	const rowHeight = ROW_LABEL_HEIGHT + barHeight

	const highlighted = hovered?.seriesIndex ?? hoveredSeries
	const tooltip =
		hovered && props.renderTooltip
			? props.renderTooltip(hovered)
			: hoveredSeries !== null && props.renderLegendTooltip
				? props.renderLegendTooltip(hoveredSeries)
				: null

	const legend = (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
			{props.legendLeading}
			<div className="flex shrink-0 items-center gap-2">
				<ul className="flex flex-wrap gap-x-2.5 gap-y-0.5" onPointerLeave={() => setHoveredSeries(null)}>
					{props.series.map((series, seriesIndex) => (
						<li
							key={series.key}
							className={cn(
								'flex items-center gap-1 text-xs text-text-2 cursor-default whitespace-nowrap',
								highlighted !== null && highlighted !== seriesIndex && 'opacity-50',
							)}
							onPointerEnter={() => setHoveredSeries(seriesIndex)}
						>
							<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
							{series.label}
						</li>
					))}
				</ul>
				{props.legendExtra}
			</div>
			{props.legendTrailing && <span className="ml-auto">{props.legendTrailing}</span>}
		</div>
	)

	// one svg per row when side by side, so each column measures its own width; one shared svg otherwise
	const columnWidth = props.sideBySide ? Math.max(0, (width - 16) / 2) : width
	const renderRow = (row: Chart.Row, rowIndex: number, mirror: boolean, top: number, w: number) => {
		const px = (value: number) => Chart.project(value, axis.max, w)
		const labelColor = props.rowColors?.[rowIndex]
		return (
			<g key={row.key}>
				<text
					x={mirror ? w : 0}
					y={top + LABEL_SIZE}
					fontSize={LABEL_SIZE}
					textAnchor={mirror ? 'end' : 'start'}
					className={cn('fill-current font-semibold', !labelColor && 'text-text-2')}
					style={labelColor ? { color: labelColor } : undefined}
				>
					{row.label}
				</text>
				<text
					x={mirror ? 0 : w}
					y={top + LABEL_SIZE}
					fontSize={LABEL_SIZE}
					textAnchor={mirror ? 'start' : 'end'}
					className="fill-current text-foreground font-semibold"
				>
					{totals[rowIndex]}
				</text>
				{Chart.stack(row.values).map((segment, i, segments) => {
					const gap = i < segments.length - 1 ? SEGMENT_GAP : 0
					const segWidth = px(segment.value) - gap
					const x = mirror ? w - px(segment.start) - segWidth : px(segment.start)
					const label = String(segment.value)
					const dimmed = highlighted !== null && highlighted !== segment.seriesIndex
					const datum = { rowIndex, seriesIndex: segment.seriesIndex, value: segment.value }
					return (
						<g
							key={props.series[segment.seriesIndex].key}
							opacity={dimmed ? DIM_OPACITY : 1}
							className={props.onSegmentClick ? 'cursor-pointer' : undefined}
							onPointerEnter={() => setHovered(datum)}
							onClick={(e) => props.onSegmentClick?.(datum, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })}
						>
							<rect
								x={x}
								y={top + ROW_LABEL_HEIGHT}
								width={Math.max(segWidth, 1)}
								height={barHeight}
								fill={props.series[segment.seriesIndex].color}
							/>
							{Chart.estimateTextWidth(label, LABEL_SIZE) + 6 <= segWidth && (
								<text
									x={x + segWidth / 2}
									y={top + ROW_LABEL_HEIGHT + barHeight / 2}
									fontSize={LABEL_SIZE}
									textAnchor="middle"
									dominantBaseline="central"
									fill="#fff"
									stroke="#0009"
									strokeWidth={2.5}
									paintOrder="stroke"
									className="font-semibold pointer-events-none select-none"
								>
									{label}
								</text>
							)}
						</g>
					)
				})}
			</g>
		)
	}
	const renderAxis = (mirror: boolean, height: number, w: number) => (
		<>
			<g className="text-line-soft" stroke="currentColor" strokeWidth={1} opacity={0.6}>
				{axis.ticks.map((tick) => {
					const px = Chart.project(tick, axis.max, w)
					const x = Math.round(mirror ? w - px : px) + 0.5
					return <line key={tick} x1={x} x2={x} y1={0} y2={height - AXIS_HEIGHT} />
				})}
			</g>
			<g className="fill-current text-text-3 font-mono" fontSize={10}>
				{axis.ticks.map((tick, i) => {
					const px = Chart.project(tick, axis.max, w)
					const first = i === 0
					const last = i === axis.ticks.length - 1
					return (
						<text
							key={tick}
							x={mirror ? w - px : px}
							y={height - 4}
							textAnchor={(mirror ? last : first) ? 'start' : (mirror ? first : last) ? 'end' : 'middle'}
						>
							{tick}
						</text>
					)
				})}
			</g>
		</>
	)

	let body: React.ReactNode = null
	if (width > 0 && props.sideBySide && props.rows.length === 2) {
		const height = rowHeight + AXIS_HEIGHT
		body = (
			<div className="grid grid-cols-2 gap-4" onPointerLeave={() => setHovered(null)}>
				{props.rows.map((row, rowIndex) => {
					const mirror = rowIndex === 0
					return (
						<svg key={row.key} width={columnWidth} height={height} role="img" aria-label={props.ariaLabel}>
							{renderAxis(mirror, height, columnWidth)}
							{renderRow(row, rowIndex, mirror, 0, columnWidth)}
						</svg>
					)
				})}
			</div>
		)
	} else if (width > 0) {
		const height = props.rows.length * rowHeight + Math.max(0, props.rows.length - 1) * ROW_GAP + AXIS_HEIGHT
		body = (
			<svg width={width} height={height} role="img" aria-label={props.ariaLabel} onPointerLeave={() => setHovered(null)}>
				{renderAxis(false, height, width)}
				{props.rows.map((row, rowIndex) => renderRow(row, rowIndex, false, rowIndex * (rowHeight + ROW_GAP), width))}
			</svg>
		)
	}

	return (
		<div ref={setContainer} className={cn('w-full', props.className)}>
			{props.legendPortal ? createPortal(legend, props.legendPortal) : <div className="mb-1">{legend}</div>}
			{body}
			<TrackingTooltip content={tooltip} />
		</div>
	)
}

function useMeasuredWidth(el: HTMLElement | null) {
	const subscribe = React.useCallback(
		(onResize: () => void) => {
			if (!el) return () => {}
			const observer = new ResizeObserver(onResize)
			observer.observe(el)
			return () => observer.disconnect()
		},
		[el],
	)
	const getSnapshot = React.useCallback(() => el?.clientWidth ?? 0, [el])
	return React.useSyncExternalStore(subscribe, getSnapshot, () => 0)
}
