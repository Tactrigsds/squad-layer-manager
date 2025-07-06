import { assertNever } from '@/lib/type-guards'

export const serializers = {
	bigint: (n: bigint) => n.toString() + 'n',
}

/**
 * If the source format has only a single severity that matches the meaning of the range
 * then it is recommended to assign that severity the smallest value of the range.
 * https://github.com/open-telemetry/opentelemetry-specification/blob/fc8289b8879f3a37e1eba5b4e445c94e74b20359/specification/logs/data-model.md#mapping-of-severitynumber
 */
export const SEVERITY_NUMBER_MAP = {
	10: 1, // TRACE
	20: 5, // DEBUG
	30: 9, // INFO
	40: 13, // WARN
	50: 17, // ERROR
	60: 21, // FATAL
}

export const LEVELS = {
	10: 'TRACE',
	20: 'DEBUG',
	30: 'INFO',
	40: 'WARN',
	50: 'ERROR',
	60: 'FATAL',
} as const

export function showLogEvent(obj: any & { level: number }) {
	// Format time with 24h time format (HH:MM:SS)
	const dateObj = new Date(obj.time)
	const time = dateObj.toLocaleTimeString([], { hour12: false })
	const dimColor = '\x1b[2m' // Dim/reduced weight ANSI escape code
	const resetColor = '\x1b[0m'

	const level = obj.level
	const levelLabel = Object.entries(LEVELS).find(([lvl]) => Number(lvl) === level)?.[1] || 'UNKNOWN'

	// Color coding based on level
	let levelColor = ''
	let log: typeof console.log

	switch (levelLabel) {
		case 'TRACE':
			levelColor = '\x1b[90m' // grey
			log = console.debug
			break
		case 'DEBUG':
			levelColor = '\x1b[36m' // cyan
			log = console.debug
			break
		case 'INFO':
			levelColor = '\x1b[32m' // green
			log = console.log
			break
		case 'WARN':
			levelColor = '\x1b[33m' // yellow
			log = console.warn
			break
		case 'ERROR':
			levelColor = '\x1b[31m' // red
			log = console.error
			break
		case 'FATAL':
			levelColor = '\x1b[35m' // magenta
			log = console.error
			break
		case 'UNKNOWN':
			log = console.log
			break
		default:
			assertNever(levelLabel)
	}

	// Format message part
	const msg = typeof obj.msg === 'string' ? obj.msg : JSON.stringify(obj.msg)

	// Extract additional properties
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { time: _, level: __, msg: ___, pid, hostname, ...props } = obj

	// Format additional context if any
	let context = ''
	if (Object.keys(props).length > 0) {
		context = `\n  ${
			Object.entries(props)
				.map(([key, val]) => `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`)
				.join('\n  ')
		}`
	}

	log(`${dimColor}${time}${resetColor} ${levelColor}[${levelLabel.padEnd(5)}]${resetColor} ${msg}${context}`)
}
