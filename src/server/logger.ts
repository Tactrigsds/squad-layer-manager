import { flattenObjToAttrs } from '@/lib/object'
import type * as CS from '@/models/context-shared'
import * as LOG from '@/models/logs'
import { sdk as otelSdk } from '@/server/systems/otel'
import * as Otel from '@opentelemetry/api'
import type { Logger as OtelLogger, LoggerProvider } from '@opentelemetry/api-logs'
import type { LoggerOptions } from 'pino'
import pino from 'pino'
import format from 'quick-format-unescaped'
import * as Env from './env'

import { assertNever } from '@/lib/type-guards'
export let baseLogger!: CS.Logger

let otelLogger: OtelLogger | undefined

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>

export function ensureLoggerSetup() {
	ENV = envBuilder()
	if (baseLogger) return
	otelLogger = ((otelSdk as any)?._loggerProvider as LoggerProvider)?.getLogger('squad-layer-manager')
	const hooks: pino.LoggerOptions['hooks'] = {
		logMethod(_inputArgs, method, level) {
			let inputArgs = [..._inputArgs]
			if (!otelLogger) {
				return method.apply(this, _inputArgs)
			}
			const span = Otel.trace.getActiveSpan()
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
			otelLogger.emit({ body: msg, attributes: attrs, severityText: LOG.LEVELS[level], severityNumber: LOG.SEVERITY_NUMBER_MAP[level] })

			return method.apply(this, _inputArgs)
		},
	}

	let baseConfig: LoggerOptions

	switch (ENV.NODE_ENV) {
		case 'development':
		case 'test':
			baseConfig = {
				level: ENV.LOG_LEVEL_OVERRIDE ?? 'debug',
				serializers: LOG.serializers,
				base: undefined,
				hooks,
			}
			break
		case 'production':
			baseConfig = {
				level: ENV.LOG_LEVEL_OVERRIDE ?? 'info',
				base: undefined,
				serializers: LOG.serializers,
				hooks,
			}
			break
		default:
			assertNever(ENV.NODE_ENV)
	}

	baseLogger = pino(baseConfig, { write: (msg) => LOG.showLogEvent(JSON.parse(msg)) })
}
