import * as dateFns from 'date-fns'
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
	const formatTime = React.useMemo(() => {
		if (props.formatTime) {
			return props.formatTime
		}
		return props.zeros ? formatTimeLeftWithZeros : formatTimeLeft
	}, [props.formatTime, props.zeros])
	if (!props.start && !props.deadline) {
		throw new Error('Timer requires exclusively either start or deadline')
	}

	// I don't trust react to do this performantly
	React.useLayoutEffect(() => {
		const intervalId = setInterval(() => {
			let displayTimeMs: number

			if (props.deadline) {
				displayTimeMs = Math.max(props.deadline - Date.now(), 0)
			} else if (props.start) {
				displayTimeMs = Math.max(Date.now() - props.start, 0)
			} else {
				displayTimeMs = 0
			}

			const formatted = formatTime(displayTimeMs)
			if (formatted !== eltRef.current!.innerText) {
				eltRef.current!.innerText = formatted
			}
		}, 50)
		return () => clearInterval(intervalId)
	}, [props.start, props.deadline, formatTime])

	return <div ref={eltRef} className={props.className} />
}

export function formatTimeLeft(timeLeft: number) {
	const duration = dateFns.intervalToDuration({ start: 0, end: timeLeft })
	const hours = duration.hours || 0
	const minutes = duration.minutes || 0
	const seconds = String(duration.seconds || 0).padStart(2, '0')

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
	} else if (minutes > 0) {
		return `${minutes}:${seconds}`
	} else {
		return seconds
	}
}

export function formatTimeLeftWithZeros(timeLeft: number) {
	const duration = dateFns.intervalToDuration({ start: 0, end: timeLeft })
	const hours = duration.hours || 0
	const minutes = duration.minutes || 0
	const seconds = String(duration.seconds || 0).padStart(2, '0')

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds}`
}
