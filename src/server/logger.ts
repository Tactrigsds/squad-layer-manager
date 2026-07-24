import { flattenObjToAttrs } from '@/lib/object'
import type { OtelModule } from '@/lib/otel'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as LOG from '@/models/logs'
import * as ATTRS from '@/models/otel-attrs'
import * as Otel from '@opentelemetry/api'
import * as OtelLogs from '@opentelemetry/api-logs'
import type { Logger as OtelLogger } from '@opentelemetry/api-logs'
import type { NodeSDK } from '@opentelemetry/sdk-node'
import type { LoggerOptions } from 'pino'
import pino from 'pino'
import format from 'quick-format-unescaped'
import * as Env from './env'
export let baseLogger!: CS.Logger

export function initModule(name: string): OtelModule {
	// memoized: spanOp calls getLogger() on every invocation, and each pino child allocation also
	// invalidates the bindings cache below, which is keyed on the logger instance.
	let log: pino.Logger | undefined
	return {
		name: name,
		getLogger: () => log ??= baseLogger.child({ [ATTRS.Module.NAME]: name }),
		tracer: Otel.trace.getTracer(name),
	}
}

// The otel SDK is pushed in by otel.server's setupOtel (via setOtelSdk) rather than imported, so
// that this widely-imported module stays a leaf: a value import of otel.server created a
// logger -> otel.server -> cleanup.server -> logger cycle whose init order (under Node's ESM loader)
// left esbuild's keepNames `__name` helper unassigned when cleanup's top-level initModule ran.
let otelEnabled = false
export function setOtelSdk(_sdk: NodeSDK) {
	otelEnabled = true
}

const DEFAULT_SCOPE = 'squad-layer-manager'
const otelLoggers = new Map<string, OtelLogger>()

// Resolved on first use rather than at setup: NodeSDK only registers the global logger provider in
// start(), so resolving eagerly would latch onto the no-op provider and silently drop every record.
// Scoped per module so `scope_name` identifies the emitting component, matching how tracers are
// scoped by module.
function getOtelLogger(scope: string) {
	if (!otelEnabled) return undefined
	let logger = otelLoggers.get(scope)
	if (!logger) {
		logger = OtelLogs.logs.getLogger(scope)
		otelLoggers.set(scope, logger)
	}
	return logger
}

// pino merges a child's bindings at serialization time, which is downstream of the logMethod hook:
// the hook only ever sees the call arguments. Without this the module name (and every other binding)
// reaches the console formatter but never the otel log record. bindings() parses the accumulated
// chindings string, so cache it per logger instance rather than paying for it on every call.
const bindingsCache = new WeakMap<pino.Logger, Record<string, unknown>>()
function getBindings(log: pino.Logger) {
	let bindings = bindingsCache.get(log)
	if (!bindings) {
		bindings = flattenObjToAttrs(log.bindings(), '_', 3)
		bindingsCache.set(log, bindings)
	}
	return bindings
}

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>

export function ensureLoggerSetup() {
	ENV = envBuilder()
	if (baseLogger) return
	const hooks: pino.LoggerOptions['hooks'] = {
		logMethod(_inputArgs, method, level) {
			let inputArgs = [..._inputArgs]
			if (!otelEnabled) {
				return method.apply(this, _inputArgs)
			}
			const bindings = getBindings(this)
			const otelLogger = getOtelLogger((bindings[ATTRS.Module.NAME] as string | undefined) ?? DEFAULT_SCOPE)!
			const span = Otel.trace.getActiveSpan()
			let attrs = {} as Record<string, unknown>
			let msg = null
			for (let i = 0; i < inputArgs.length; i++) {
				const arg = inputArgs[i]
				if (typeof arg === 'string') {
					msg = format(arg, inputArgs.slice(i + 1))
					break
				}
			}

			if (inputArgs.length === 0) {
				inputArgs = ['']
			} else if (inputArgs[0] instanceof Error) {
				console.error(inputArgs[0])
				const obj = inputArgs[0] as Error
				// exception.* rather than error.*: this is the semconv the log data model defines, and
				// what backends key off to render a stack trace as one (`error.stack` isn't an attribute
				// at all, so Grafana would show it as an opaque string).
				attrs['exception.type'] = obj.name
				attrs['exception.message'] = obj.message
				attrs['exception.stacktrace'] = obj.stack
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

			otelLogger.emit({
				// pino's own timestamp, rather than leaving the record with only an observedTimestamp
				// stamped whenever the batch processor happens to see it.
				timestamp: Date.now(),
				body: msg === null ? undefined : LOG.stripAnsi(msg),
				// bindings first so explicit call-site args win, matching pino's own precedence. They're
				// spread into a copy rather than into `attrs` because pino re-adds them itself when it
				// serializes, and `attrs` is what we hand back to it as inputArgs[0].
				attributes: { ...bindings, ...attrs } as OtelLogs.LogAttributes,
				severityText: LOG.LEVELS[level as keyof typeof LOG.LEVELS],
				severityNumber: LOG.SEVERITY_NUMBER_MAP[level as keyof typeof LOG.SEVERITY_NUMBER_MAP] as OtelLogs.SeverityNumber,
			})

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

	baseLogger = pino(baseConfig, { write: (msg) => LOG.showLogEvent(JSON.parse(msg), true, ENV.LOG_EXCLUDE_CONTEXT_PARAMS) })
}
