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
	return {
		name: name,
		getLogger: () => module.getLogger().child({ [ATTRS.Module.NAME]: name }),
		tracer: Otel.trace.getTracer(name),
	}
}
