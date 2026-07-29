import * as React from 'react'

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
 */
export function StackedBarChart(props: {
	rows: Chart.Row[]
	series: Chart.Series[]
	barHeight?: number
	className?: string
	ariaLabel?: string
	renderTooltip?: (datum: Chart.Datum) => React.ReactNode
	renderLegendTooltip?: (seriesIndex: number) => React.ReactNode
	// what the modifiers mean is the caller's to decide; the chart only reports which were held
	onSegmentClick?: (datum: Chart.Datum, modifiers: { shift: boolean; ctrl: boolean }) => void
}) {
	const barHeight = props.barHeight ?? 20
	const [container, setContainer] = React.useState<HTMLDivElement | null>(null)
	const width = useMeasuredWidth(container)
	const [hovered, setHovered] = React.useState<Chart.Datum | null>(null)
	const [hoveredSeries, setHoveredSeries] = React.useState<number | null>(null)

	const totals = props.rows.map((row) => Chart.total(row.values))
	const axis = Chart.axis(Math.max(...totals, 0), 4, { integer: true })
	const rowHeight = ROW_LABEL_HEIGHT + barHeight
	const height = props.rows.length * rowHeight + Math.max(0, props.rows.length - 1) * ROW_GAP + AXIS_HEIGHT

	const highlighted = hovered?.seriesIndex ?? hoveredSeries
	const tooltip =
		hovered && props.renderTooltip
			? props.renderTooltip(hovered)
			: hoveredSeries !== null && props.renderLegendTooltip
				? props.renderLegendTooltip(hoveredSeries)
				: null

	return (
		<div ref={setContainer} className={cn('w-full', props.className)}>
			<ul className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1" onPointerLeave={() => setHoveredSeries(null)}>
				{props.series.map((series, seriesIndex) => (
					<li
						key={series.key}
						className={cn(
							'flex items-center gap-1 text-xs text-muted-foreground cursor-default transition-opacity',
							highlighted !== null && highlighted !== seriesIndex && 'opacity-50',
						)}
						onPointerEnter={() => setHoveredSeries(seriesIndex)}
					>
						<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
						{series.label}
					</li>
				))}
			</ul>
			{width > 0 && (
				<svg width={width} height={height} role="img" aria-label={props.ariaLabel} onPointerLeave={() => setHovered(null)}>
					<g className="text-border" stroke="currentColor" strokeWidth={1} opacity={0.6}>
						{axis.ticks.map((tick) => {
							const x = Math.round(Chart.project(tick, axis.max, width)) + 0.5
							return <line key={tick} x1={x} x2={x} y1={0} y2={height - AXIS_HEIGHT} />
						})}
					</g>
					{props.rows.map((row, rowIndex) => {
						const top = rowIndex * (rowHeight + ROW_GAP)
						return (
							<g key={row.key}>
								<text x={0} y={top + LABEL_SIZE} fontSize={LABEL_SIZE} className="fill-current text-muted-foreground">
									{row.label}
								</text>
								<text
									x={width}
									y={top + LABEL_SIZE}
									fontSize={LABEL_SIZE}
									textAnchor="end"
									className="fill-current text-foreground font-semibold"
								>
									{totals[rowIndex]}
								</text>
								{Chart.stack(row.values).map((segment, i, segments) => {
									const x = Chart.project(segment.start, axis.max, width)
									// a hairline of background between neighbours, so two similar colours still read as two segments
									const gap = i < segments.length - 1 ? SEGMENT_GAP : 0
									const segWidth = Chart.project(segment.value, axis.max, width) - gap
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
					})}
					<g className="fill-current text-muted-foreground" fontSize={LABEL_SIZE}>
						{axis.ticks.map((tick, i) => (
							<text
								key={tick}
								x={Chart.project(tick, axis.max, width)}
								y={height - 4}
								textAnchor={i === 0 ? 'start' : i === axis.ticks.length - 1 ? 'end' : 'middle'}
							>
								{tick}
							</text>
						))}
					</g>
				</svg>
			)}
			<TrackingTooltip content={tooltip} />
		</div>
	)
}

function useMeasuredWidth(el: HTMLElement | null) {
	const [width, setWidth] = React.useState(0)
	React.useEffect(() => {
		if (!el) return
		const observer = new ResizeObserver(() => setWidth(el.clientWidth))
		observer.observe(el)
		setWidth(el.clientWidth)
		return () => observer.disconnect()
	}, [el])
	return width
}
