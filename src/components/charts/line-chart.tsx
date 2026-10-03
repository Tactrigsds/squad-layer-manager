import * as React from 'react'

import { TrackingTooltip } from '@/components/ui/tooltip'
import * as Chart from '@/lib/chart'
import { cn } from '@/lib/utils'

import { useMeasuredSize } from './measure'

const AXIS_FONT = 10
const END_LABEL_FONT = 11
const AXIS_HEIGHT = 16
const TOP_PAD = 8
const END_LABEL_GAP = 13
const MIN_PLOT = 40

/**
 * Step lines over a shared x axis, filling its container: the parent decides the size. Each series is labelled with
 * its last value at the end of its line. Hovering shows a crosshair and `renderTooltip` for that x.
 *
 * `signed` centres the y axis on zero and shades the area between the line and zero, `above` colour over it and
 * `below` colour under it, for a single series that measures one side against the other.
 */
export function LineChart(props: {
	series: Chart.LineSeries[]
	xMax: number
	formatX: (x: number) => string
	xTicks: (xMax: number, targetTicks: number) => number[]
	signed?: { above: string; below: string }
	ariaLabel?: string
	className?: string
	renderTooltip?: (x: number, values: (number | undefined)[]) => React.ReactNode
}) {
	const [container, setContainer] = React.useState<HTMLDivElement | null>(null)
	const { width, height } = useMeasuredSize(container)
	const [hoverX, setHoverX] = React.useState<number | null>(null)
	const clipId = React.useId()

	let maxY = 0
	let maxAbs = 0
	for (const series of props.series) {
		for (const point of series.points) {
			if (point.y > maxY) maxY = point.y
			if (Math.abs(point.y) > maxAbs) maxAbs = Math.abs(point.y)
		}
	}

	const plotHeight = height - AXIS_HEIGHT - TOP_PAD
	const targetYTicks = Math.max(2, Math.floor(plotHeight / 32))
	const yAxis = props.signed
		? Chart.signedAxis(maxAbs, Math.max(1, Math.floor(targetYTicks / 2)))
		: { min: 0, ...Chart.axis(maxY, targetYTicks, { integer: true }) }
	const formatY = (value: number) => (props.signed && value > 0 ? `+${value}` : String(value))

	const finals = props.series.map((series) => series.points[series.points.length - 1]?.y ?? 0)
	const yLabelWidth = Math.max(...yAxis.ticks.map((tick) => Chart.estimateNumeralsWidth(formatY(tick), AXIS_FONT)))
	const endLabelWidth = Math.max(0, ...finals.map((value) => Chart.estimateNumeralsWidth(formatY(value), END_LABEL_FONT)))
	const left = Math.ceil(yLabelWidth) + 6
	const right = Math.ceil(endLabelWidth) + 12
	const plotWidth = width - left - right

	const ready = plotWidth >= MIN_PLOT && plotHeight >= MIN_PLOT
	const xToPx = (x: number) => left + Chart.project(x, props.xMax, plotWidth)
	const yToPx = (y: number) => TOP_PAD + plotHeight - Chart.project(y - yAxis.min, yAxis.max - yAxis.min, plotHeight)

	const stepPath = (points: readonly Chart.Point[]) => {
		if (points.length === 0) return ''
		let d = `M${xToPx(points[0].x)} ${yToPx(points[0].y)}`
		for (let i = 1; i < points.length; i++) d += `H${xToPx(points[i].x)}V${yToPx(points[i].y)}`
		return d + `H${xToPx(props.xMax)}`
	}

	const onPointerMove = (e: React.PointerEvent<SVGRectElement>) => {
		const rect = e.currentTarget.getBoundingClientRect()
		const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
		setHoverX(ratio * props.xMax)
	}

	const hoverValues = hoverX === null ? null : props.series.map((series) => Chart.valueAt(series.points, hoverX))
	const tooltip = hoverX !== null && hoverValues && props.renderTooltip ? props.renderTooltip(hoverX, hoverValues) : null

	let body: React.ReactNode = null
	if (ready) {
		const zeroY = yToPx(0)
		const xTicks = props.xTicks(props.xMax, Math.max(2, Math.floor(plotWidth / 72)))
		const endLabels = spreadLabels(
			finals.map((value) => yToPx(value)),
			END_LABEL_GAP,
			TOP_PAD,
			TOP_PAD + plotHeight,
		)
		body = (
			<svg width={width} height={height} role="img" aria-label={props.ariaLabel} className="block">
				<g className="text-line-soft" stroke="currentColor" strokeWidth={1} opacity={0.6}>
					{yAxis.ticks.map((tick) => {
						const y = Math.round(yToPx(tick)) + 0.5
						return <line key={tick} x1={left} x2={left + plotWidth} y1={y} y2={y} />
					})}
				</g>
				<line
					className="text-ctl-hi"
					stroke="currentColor"
					x1={left}
					x2={left + plotWidth}
					y1={Math.round(zeroY) + 0.5}
					y2={Math.round(zeroY) + 0.5}
				/>
				<g className="fill-current text-text-3 font-mono" fontSize={AXIS_FONT}>
					{yAxis.ticks.map((tick) => (
						<text key={tick} x={left - 4} y={yToPx(tick)} textAnchor="end" dominantBaseline="central">
							{formatY(tick)}
						</text>
					))}
					{xTicks.map((tick, i) => (
						<text
							key={tick}
							x={xToPx(tick)}
							y={height - 3}
							textAnchor={i === 0 && tick === 0 ? 'start' : xToPx(tick) > left + plotWidth - 20 ? 'end' : 'middle'}
						>
							{props.formatX(tick)}
						</text>
					))}
				</g>
				{props.signed && props.series[0] && (
					<>
						<defs>
							<clipPath id={`${clipId}-above`}>
								<rect x={left} y={TOP_PAD} width={plotWidth} height={Math.max(0, zeroY - TOP_PAD)} />
							</clipPath>
							<clipPath id={`${clipId}-below`}>
								<rect x={left} y={zeroY} width={plotWidth} height={Math.max(0, TOP_PAD + plotHeight - zeroY)} />
							</clipPath>
						</defs>
						{(['above', 'below'] as const).map((side) => (
							<path
								key={side}
								d={`${stepPath(props.series[0].points)}V${zeroY}H${left}Z`}
								fill={props.signed![side]}
								fillOpacity={0.3}
								clipPath={`url(#${clipId}-${side})`}
							/>
						))}
					</>
				)}
				{props.series.map((series) => (
					<path
						key={series.key}
						d={stepPath(series.points)}
						fill="none"
						stroke={props.signed ? 'currentColor' : series.color}
						className={props.signed ? 'text-text-2' : undefined}
						strokeWidth={2}
						strokeLinejoin="round"
					/>
				))}
				<g fontSize={END_LABEL_FONT} className="font-mono font-semibold">
					{props.series.map((series, i) => (
						<g key={series.key}>
							<circle
								cx={left + plotWidth}
								cy={yToPx(finals[i])}
								r={3}
								fill={props.signed ? 'currentColor' : series.color}
								className="text-text-2"
							/>
							<text x={left + plotWidth + 7} y={endLabels[i]} dominantBaseline="central" className="fill-current text-foreground">
								{formatY(finals[i])}
							</text>
						</g>
					))}
				</g>
				{hoverX !== null && hoverValues && (
					<g pointerEvents="none">
						<line
							x1={xToPx(hoverX)}
							x2={xToPx(hoverX)}
							y1={TOP_PAD}
							y2={TOP_PAD + plotHeight}
							stroke="currentColor"
							className="text-text-2"
							strokeWidth={1}
						/>
						{props.series.map((series, i) =>
							hoverValues[i] === undefined ? null : (
								<circle
									key={series.key}
									cx={xToPx(hoverX)}
									cy={yToPx(hoverValues[i]!)}
									r={4}
									fill={props.signed ? 'currentColor' : series.color}
									stroke="var(--panel)"
									strokeWidth={2}
									className="text-text-2"
								/>
							),
						)}
					</g>
				)}
				<rect
					x={left}
					y={TOP_PAD}
					width={plotWidth}
					height={plotHeight}
					fill="transparent"
					onPointerMove={onPointerMove}
					onPointerLeave={() => setHoverX(null)}
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

// Nudges label centres apart so no two are closer than `gap`, keeping each as near its line's end as it can and all of
// them within [min, max]. The input order is kept: label i belongs to series i.
function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
	const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
	for (let k = 1; k < order.length; k++) {
		if (order[k].y - order[k - 1].y < gap) order[k].y = order[k - 1].y + gap
	}
	const overflow = order.length > 0 ? order[order.length - 1].y - max : 0
	if (overflow > 0) for (const label of order) label.y -= overflow
	for (const label of order) label.y = Math.max(min, label.y)
	const out = new Array<number>(ys.length)
	for (const label of order) out[label.i] = label.y
	return out
}
