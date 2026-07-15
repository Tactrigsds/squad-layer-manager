import { formatVersion } from '@/lib/versioning.ts'

import * as Env from '@/server/env'
import * as Logger from '@/server/logger'
import * as Cleanup from '@/systems/cleanup.server'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'

import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { logs, NodeSDK, tracing } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { ORPCInstrumentation } from '@orpc/otel'
import { randomBytes } from 'crypto'

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.otel })
let ENV!: ReturnType<typeof envBuilder>

const getCollectorEndpoint = (path: string) => {
	const baseUrl = ENV.OTLP_COLLECTOR_ENDPOINT
	return `${baseUrl}${path}`
}

export let sdk!: NodeSDK

// a unique id for this SLM process (otel's service.instance.id). exported so app events can record which instance
// emitted them, and so restart detection can correlate by instance rather than by timestamp.
export const instanceId = `${Date.now()}-${randomBytes(4).toString('hex')}`

// doesn't start the SDK
export function setupOtel() {
	ENV = envBuilder()
	console.log('Setting up OpenTelemetry...')

	// Without this the http instrumentation emits both generations of the semconv at once: every span
	// carries http.method *and* http.request.method, and every duration is recorded twice, once as
	// http.*.duration (ms, deprecated) and once as http.*.request.duration (s, stable). Set here rather
	// than in the deploy env so it can't be forgotten; the instrumentations read it when constructed
	// just below. ??= so an operator can still override it.
	process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http'

	const traceExporter = new OTLPTraceExporter({ url: getCollectorEndpoint('/v1/traces') })
	const metricExporter = new OTLPMetricExporter({ url: getCollectorEndpoint('/v1/metrics') })
	const logExporter = new OTLPLogExporter({ url: getCollectorEndpoint('/v1/logs') })

	const resource = defaultResource().merge(resourceFromAttributes({
		[ATTR_SERVICE_NAME]: 'squad-layer-manager',
		[ATTR_SERVICE_VERSION]: formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA),
		[ATTR_SERVICE_INSTANCE_ID]: instanceId,
	}))

	sdk = new NodeSDK({
		resource,
		// ParentBased so a sampled parent (e.g. an inbound traced request) keeps its whole subtree; the
		// ratio only applies to traces we root ourselves.
		sampler: new tracing.ParentBasedSampler({
			root: new tracing.TraceIdRatioBasedSampler(ENV.OTEL_TRACE_SAMPLE_RATIO),
		}),
		traceExporter: traceExporter,
		spanProcessor: new tracing.BatchSpanProcessor(traceExporter),
		metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter }),
		logRecordProcessors: [new logs.BatchLogRecordProcessor({ exporter: logExporter })],
		instrumentations: [
			getNodeAutoInstrumentations({
				// server/logger.ts already bridges every pino record to the Logs API from its `logMethod`
				// hook (where it can also attach span/baggage attrs), and LOG.mapSpanAttrs already stamps
				// trace_id/span_id onto each record. Leaving the instrumentation's log-sending on would
				// export every record twice; leaving its correlation on would re-add trace ids plus a
				// trace_flags field that showLogEvent doesn't know about, so it prints on every line.
				'@opentelemetry/instrumentation-pino': { disableLogSending: true, disableLogCorrelation: true },
			}),
			new ORPCInstrumentation(),
		],
	})

	Logger.setOtelSdk(sdk)
	Cleanup.register(() => sdk.shutdown())
}
