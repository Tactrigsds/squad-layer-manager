import { FixedSizeMap } from '@/lib/lru-map'
import { assertNever } from '@/lib/type-guards'
import * as ATTRS from '@/models/otel-attrs'
import * as Otel from '@opentelemetry/api'
import type pino from 'pino'

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

export const MAPPED_ATTRS = [
	ATTRS.Module.NAME,
	ATTRS.SquadServer.ID,
	ATTRS.User.ID,
	ATTRS.WebSocket.CLIENT_ID,
	ATTRS.Span.ROOT_NAME,
]

// Color coding for modules, spans, and traces
const COLORS = [
	'\x1b[36m', // cyan
	'\x1b[35m', // magenta
	'\x1b[33m', // yellow
	'\x1b[32m', // green
	'\x1b[34m', // blue
	'\x1b[95m', // bright magenta
	'\x1b[96m', // bright cyan
	'\x1b[93m', // bright yellow
	'\x1b[92m', // bright green
	'\x1b[94m', // bright blue
	'\x1b[91m', // bright red
	'\x1b[97m', // bright white
	'\x1b[90m', // bright black (grey)
	'\x1b[31m', // red
	'\x1b[37m', // white
	'\x1b[38;5;208m', // orange
	'\x1b[38;5;129m', // purple
	'\x1b[38;5;51m', // light cyan
	'\x1b[38;5;213m', // pink
	'\x1b[38;5;82m', // lime green
]

const modulesMap = new FixedSizeMap<string, number>(500)
let modulesOffset = 0

function getModuleColor(moduleName: string): string {
	let idx = modulesMap.get(moduleName)
	if (idx === undefined) {
		idx = modulesOffset++
		modulesMap.set(moduleName, idx)
	}
	return COLORS[idx % COLORS.length]
}

const spanNamesMap = new FixedSizeMap<string, number>(500)
let spanNamesOffset = 0

function getSpanColor(spanName: string): string {
	let idx = spanNamesMap.get(spanName)
	if (idx === undefined) {
		idx = spanNamesOffset++
		spanNamesMap.set(spanName, idx)
	}
	return COLORS[idx % COLORS.length]
}

const traceIdsMap = new FixedSizeMap<string, number>(500)
let traceIdsOffset = 0

function getTraceColor(traceId: string): string {
	let idx = traceIdsMap.get(traceId)
	if (idx === undefined) {
		idx = traceIdsOffset++
		traceIdsMap.set(traceId, idx)
	}
	return COLORS[idx % COLORS.length]
}

export function getSubmoduleLogger(submodule: string, log: pino.Logger) {
	const parentModule = log.bindings()[ATTRS.Module.NAME]
	const module = parentModule ? `${parentModule}/${submodule}` : submodule
	return log.child({ [ATTRS.Module.NAME]: module })
}

// Type guard for SDK span with internal properties
interface SdkSpan extends Otel.Span {
	name?: string
}

export function mapSpanAttrs(span: Otel.Span, record: Record<string, any>) {
	const sdkSpan = span as SdkSpan

	// Access attributes from baggage
	const baggage = Otel.propagation.getBaggage(Otel.context.active())
	if (baggage) {
		for (const attr of MAPPED_ATTRS) {
			const entry = baggage.getEntry(attr)
			if (entry?.value !== undefined) {
				record[attr] = entry.value
			}
		}
	}

	// Map span context IDs
	const spanContext = span.spanContext()
	if (!('span_id' in record)) {
		record.span_id = spanContext.spanId
	}
	if (!('trace_id' in record)) {
		record.trace_id = spanContext.traceId
	}

	// Include span name if not already in record
	if (!('span_name' in record) && sdkSpan.name) {
		record.span_name = sdkSpan.name
	}

	// Include root span name if available in baggage
	if (!('root_span_name' in record) && baggage) {
		const rootSpanEntry = baggage.getEntry(ATTRS.Span.ROOT_NAME)
		if (rootSpanEntry?.value) {
			record.root_span_name = rootSpanEntry.value
		}
	}
}

export function showLogEvent(obj: { level: number; [key: string]: unknown }, showAdditionalContext = true) {
	// Format time with 24h time format (HH:MM:SS)
	const dateObj = new Date(obj.time as number)
	const time = dateObj.toLocaleTimeString([], { hour12: false })
	const dimColor = '\x1b[2m' // Dim/reduced weight ANSI escape code
	const resetColor = '\x1b[0m'

	const level = obj.level
	const levelLabel = (LEVELS[level as keyof typeof LEVELS] ?? 'UNKNOWN') as (typeof LEVELS)[keyof typeof LEVELS] | 'UNKNOWN'

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
	const {
		time: _,
		level: __,
		msg: ___,
		pid: _pid,
		hostname: _hostname,
		span_name: rawSpanName,
		[ATTRS.Module.NAME]: rawModuleName,
		[ATTRS.SquadServer.ID]: rawServerId,
		[ATTRS.User.ID]: rawUserId,
		[ATTRS.WebSocket.CLIENT_ID]: rawWsClientId,
		...props
	} = obj

	const moduleName = rawModuleName as string | undefined
	const spanName = rawSpanName as string | undefined
	const traceId = props.trace_id as string | undefined
	const spanId = props.span_id as string | undefined
	const serverId = rawServerId as string | undefined
	const userId = rawUserId as string | undefined
	const wsClientId = rawWsClientId as string | undefined

	// Build main bracket with level, module, span
	let mainBracketContent = levelLabel
	if (moduleName) {
		const moduleColor = getModuleColor(moduleName)
		mainBracketContent += ` ${moduleColor}${moduleName}${resetColor}`
	}
	if (spanName) {
		const spanColor = getSpanColor(spanName)
		mainBracketContent += ` ${spanColor}${spanName}${resetColor}`
	}
	const mainBracket = `${levelColor}[${mainBracketContent}]${resetColor}`

	const keyColor = '\x1b[90m' // grey for keys
	const valueColor = '\x1b[37m' // white for values
	const contextParts: string[] = []
	if (traceId && spanId) {
		const traceColor = getTraceColor(String(traceId))
		contextParts.push(
			`${keyColor}trace=${traceColor}${String(traceId).slice(-4)}${keyColor}->${valueColor}${String(spanId).slice(-4)}${resetColor}`,
		)
	}
	if (serverId) contextParts.push(`${keyColor}server=${valueColor}${serverId}${resetColor}`)
	if (userId) contextParts.push(`${keyColor}user=${valueColor}${userId}${resetColor}`)
	if (wsClientId) contextParts.push(`${keyColor}ws=${valueColor}${wsClientId.slice(-4)}${resetColor}`)

	const contextLine = contextParts.length > 0 ? ` ${dimColor}[${resetColor}${contextParts.join(' ')}${dimColor}]${resetColor}` : ''

	// Include additional context as object parameter if any
	if (Object.keys(props).length > 0) {
		log(`${dimColor}${time}${resetColor} ${mainBracket}${contextLine} ${msg}`, props)
	} else {
		log(`${dimColor}${time}${resetColor} ${mainBracket}${contextLine} ${msg}`)
	}
}
