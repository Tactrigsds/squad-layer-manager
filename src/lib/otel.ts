import * as ATTRS from '@/models/otel-attrs'
import * as Otel from '@opentelemetry/api'
import type pino from 'pino'

export type OtelModule = {
	name: string
	tracer: Otel.Tracer
	getLogger(): pino.Logger
}

export function getChildModule(module: OtelModule, submoduleName: string) {
	const name = `${module.name}:${submoduleName}`
	// memoized: spanOp calls getLogger() on every invocation, and each pino child allocation also
	// invalidates the bindings cache that the otel bridge in server/logger.ts keys off the instance.
	let log: pino.Logger | undefined
	return {
		name: name,
		getLogger: () => log ??= module.getLogger().child({ [ATTRS.Module.NAME]: name }),
		tracer: Otel.trace.getTracer(name),
	}
}
