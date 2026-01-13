import { flattenObjToAttrs } from '@/lib/object'
import { OtelModule } from '@/lib/otel'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as LOG from '@/models/logs'
import * as ATTRS from '@/models/otel-attrs'
import { sdk as otelSdk } from '@/systems/otel.server'
import * as Otel from '@opentelemetry/api'
import type { Logger as OtelLogger, LoggerProvider } from '@opentelemetry/api-logs'
import type { LoggerOptions } from 'pino'
import pino from 'pino'
import format from 'quick-format-unescaped'
import * as Env from './env'
export let baseLogger!: CS.Logger

export function initModule(name: string): OtelModule {
	return {
		name: name,
		getLogger: () => baseLogger.child({ [ATTRS.Module.NAME]: name }),
		tracer: Otel.trace.getTracer(name),
	}
}

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
			} else if (typeof inputArgs[0] === 'object') {
				const obj = inputArgs[0]
				attrs = flattenObjToAttrs(obj, '_', 3)
				inputArgs[0] = attrs
			}
			if (attrs !== inputArgs[0]) {
				inputArgs.unshift(attrs)
			}

			// Map span attributes to log record
			if (span) {
				LOG.mapSpanAttrs(span, attrs)
			}

			// @ts-expect-error idk
			const body = { body: msg, attributes: attrs, severityText: LOG.LEVELS[level], severityNumber: LOG.SEVERITY_NUMBER_MAP[level] }

			// @ts-expect-error idk
			otelLogger.emit(body)

			return method.apply(this, inputArgs as any)
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
