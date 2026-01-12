import { formatVersion } from '@/lib/versioning.ts'
import * as LOG from '@/models/logs.ts'
import * as Env from '@/server/env'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'
import { Resource } from '@opentelemetry/resources'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { logs, NodeSDK, tracing } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { randomBytes } from 'crypto'

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>

const getCollectorEndpoint = (path: string) => {
	const baseUrl = ENV.OTLP_COLLECTOR_ENDPOINT
	return `${baseUrl}${path}`
}

export let sdk!: NodeSDK

// doesn't start the SDK
export function setupOtel() {
	ENV = envBuilder()
	console.log('Setting up OpenTelemetry...')
	const traceExporter = new OTLPTraceExporter({ url: getCollectorEndpoint('/v1/traces') })
	const metricExporter = new OTLPMetricExporter({ url: getCollectorEndpoint('/v1/metrics') })
	const logExporter = new OTLPLogExporter({ url: getCollectorEndpoint('/v1/logs') })

	const resourceAttrs = {
		[ATTR_SERVICE_NAME]: 'squad-layer-manager',
		[ATTR_SERVICE_VERSION]: formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA),
		// ATTR_SERVICE_INSTANCE_ID seems to be broken
		['service.instance.id']: `${Date.now()}-${randomBytes(4).toString('hex')}`,
	}

	sdk = new NodeSDK({
		resource: new Resource(resourceAttrs),
		traceExporter: traceExporter,
		spanProcessor: new tracing.BatchSpanProcessor(traceExporter),
		metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter }),
		logRecordProcessors: [new logs.BatchLogRecordProcessor(logExporter)],
		instrumentations: [getNodeAutoInstrumentations()// new PinoInstrumentation()
		],
	})
}
