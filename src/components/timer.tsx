import React from 'react'

export function Timer(props: {
	start?: number
	deadline?: number
	className?: string
	zeros?: boolean
	useHourMinuteFormat?: boolean
	formatTime?: (timeMs: number) => string
}) {
	const eltRef = React.useRef<HTMLDivElement>(null)
	const formatTime = props.formatTime ?? (props.zeros ? formatTimeLeftWithZeros : formatTimeLeft)
	if (!props.start && !props.deadline) {
		throw new Error('Timer requires exclusively either start or deadline')
	}

	// written straight to the dom, once per displayed second, rather than through a re-render
	React.useLayoutEffect(() => {
		const elt = eltRef.current!
		let shown: string | null = null
		let timeout: ReturnType<typeof setTimeout> | undefined
		const tick = () => {
			const now = Date.now()
			let displayTimeMs: number
			if (props.deadline) {
				displayTimeMs = Math.max(props.deadline - now, 0)
			} else if (props.start) {
				displayTimeMs = Math.max(now - props.start, 0)
			} else {
				displayTimeMs = 0
			}

			const formatted = formatTime(displayTimeMs)
			if (formatted !== shown) {
				elt.textContent = formatted
				shown = formatted
			}
			if (props.deadline && displayTimeMs === 0) return
			// sleep until the displayed second changes
			timeout = setTimeout(tick, props.deadline ? (displayTimeMs % 1000) + 1 : 1000 - (displayTimeMs % 1000))
		}
		tick()
		return () => clearTimeout(timeout)
	}, [props.start, props.deadline, formatTime])

	// tabular-nums keeps digit width stable so the ticking text doesn't jitter
	return <div ref={eltRef} className={props.className} style={{ fontVariantNumeric: 'tabular-nums' }} />
}

function durationParts(timeMs: number) {
	const totalSeconds = Math.floor(timeMs / 1000)
	return {
		hours: Math.floor(totalSeconds / 3600),
		minutes: Math.floor(totalSeconds / 60) % 60,
		seconds: String(totalSeconds % 60).padStart(2, '0'),
	}
}

export function formatTimeLeft(timeLeft: number) {
	const { hours, minutes, seconds } = durationParts(timeLeft)

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
	} else if (minutes > 0) {
		return `${minutes}:${seconds}`
	} else {
		return seconds
	}
}

export function formatTimeLeftWithZeros(timeLeft: number) {
	const { hours, minutes, seconds } = durationParts(timeLeft)

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds}`
}
