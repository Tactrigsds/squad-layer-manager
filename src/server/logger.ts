import { sdk } from '@/server/instrumentation'
import { LoggerProvider } from '@opentelemetry/api-logs'
import { Logger as PinoLogger, LoggerOptions } from 'pino'

import { flattenObjToAttrs } from '@/lib/object'
import * as Otel from '@opentelemetry/api'
import pino from 'pino'
import format from 'quick-format-unescaped'
import { ENV, Env } from './env'

import build from 'pino-abstract-transport'
export type Logger = PinoLogger
export let baseLogger!: Logger

const serializers = {
	bigint: (n: bigint) => n.toString() + 'n',
}

/**
 * If the source format has only a single severity that matches the meaning of the range
 * then it is recommended to assign that severity the smallest value of the range.
 * https://github.com/open-telemetry/opentelemetry-specification/blob/fc8289b8879f3a37e1eba5b4e445c94e74b20359/specification/logs/data-model.md#mapping-of-severitynumber
 */
const SEVERITY_NUMBER_MAP = {
	10: 1, // TRACE
	20: 5, // DEBUG
	30: 9, // INFO
	40: 13, // WARN
	50: 17, // ERROR
	60: 21, // FATAL
}

interface CommonBindings {
	msg: string
	level: keyof typeof SEVERITY_NUMBER_MAP
	time: number
	hostname?: string
	pid?: number
}

type Bindings = Record<string, string | number | object> & CommonBindings

const LEVELS = {
	10: 'TRACE',
	20: 'DEBUG',
	30: 'INFO',
	40: 'WARN',
	50: 'ERROR',
	60: 'FATAL',
} as const

const logger = ((sdk as any)._loggerProvider as LoggerProvider).getLogger('squad-layer-manager')

export async function ensureLoggerSetup() {
	if (baseLogger) return
	const hooks: pino.LoggerOptions['hooks'] = {
		logMethod(_inputArgs, method, level) {
			let inputArgs = [..._inputArgs]
			const span = Otel.default.trace.getActiveSpan()
			let attrs = {} as Record<string, unknown>
			let msg = null
			for (let i = 0; i < inputArgs.length; i++) {
				if (typeof inputArgs[i] === 'string') {
					msg = format(inputArgs[i], inputArgs.slice(i + 1))
					break
				}
			}

			if (inputArgs.length === 0) {
				inputArgs = ['']
			} else if (inputArgs[0] instanceof Error) {
				const obj = inputArgs[0] as Error
				attrs['error.type'] = obj.name
				attrs['error.message'] = obj.message
				attrs['error.stack'] = obj.stack
				inputArgs = [obj.message]
				if (msg === null) {
					msg = obj.message
				}
				if (span) {
					span.recordException(obj)
				}
			} else if (typeof inputArgs[0] === 'object' && inputArgs !== null) {
				const obj = inputArgs[0]
				attrs = flattenObjToAttrs(obj)
			}

			if (span) {
				attrs.span_id = span.spanContext().spanId
				attrs.trace_id = span.spanContext().traceId
				if (typeof inputArgs[0] === 'string' || inputArgs[0] instanceof Error) {
					inputArgs.unshift({ span_id: attrs.span_id, trace_id: attrs.trace_id, span_name: (span as any).name })
				} else if (typeof inputArgs[0] === 'object') {
					inputArgs[0] = { ...(inputArgs[0] ?? {}), span_id: attrs.span_id, trace_id: attrs.trace_id }
				}
			}

			// @ts-expect-error idk
			logger.emit({ body: msg, attributes: attrs, severityText: LEVELS[level], severityNumber: SEVERITY_NUMBER_MAP[level] })

			return method.apply(this, _inputArgs)
		},
	}
	const envToLogger = {
		development: {
			level: ENV.LOG_LEVEL_OVERRIDE ?? 'debug',
			serializers,
			base: undefined,
			hooks,
		},
		production: {
			level: ENV.LOG_LEVEL_OVERRIDE ?? 'debug',
			base: undefined,
			serializers,
			hooks,
		},
	} satisfies { [env in Env['NODE_ENV']]: LoggerOptions }

	const baseConfig = envToLogger[ENV.NODE_ENV]

	baseLogger = pino(baseConfig, createFormatPrettyPrintTransport())
}

export function createFormatPrettyPrintTransport() {
	return build(async function(source) {
		for await (const obj of source) {
			// JSON stringifying the object to handle circular refs and bigints

			// Format time with 24h time format (HH:MM:SS)
			const dateObj = new Date(obj.time)
			const time = dateObj.toLocaleTimeString([], { hour12: false })
			const dimColor = '\x1b[2m' // Dim/reduced weight ANSI escape code
			const resetColor = '\x1b[0m'

			const level = obj.level as number
			const levelLabel = Object.entries(LEVELS).find(([lvl]) => Number(lvl) === level)?.[1] || 'UNKNOWN'

			// Color coding based on level
			let levelColor = ''

			switch (levelLabel) {
				case 'TRACE':
					levelColor = '\x1b[90m' // grey
					break
				case 'DEBUG':
					levelColor = '\x1b[36m' // cyan
					break
				case 'INFO':
					levelColor = '\x1b[32m' // green
					break
				case 'WARN':
					levelColor = '\x1b[33m' // yellow
					break
				case 'ERROR':
					levelColor = '\x1b[31m' // red
					break
				case 'FATAL':
					levelColor = '\x1b[35m' // magenta
					break
			}

			// Format message part
			const msg = typeof obj.msg === 'string' ? obj.msg : JSON.stringify(obj.msg)

			// Extract additional properties
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

			console.log(`${dimColor}${time}${resetColor} ${levelColor}[${levelLabel.padEnd(5)}]${resetColor} ${msg}${context}`)
		}
	})
}
