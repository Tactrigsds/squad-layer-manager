import { NodeSDK, logs, tracing } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { randomBytes } from 'crypto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { ensureEnvSetup, ENV } from '@/server/env.ts'
import { formatVersion } from '@/lib/versioning.ts'

ensureEnvSetup()
const getCollectorEndpoint = (path: string) => {
	const baseUrl = ENV.OLTP_COLLECTOR_ENDPOINT
	return `${baseUrl}${path}`
}
const traceExporter = new OTLPTraceExporter({ url: getCollectorEndpoint('/v1/traces') })
const metricExporter = new OTLPMetricExporter({ url: getCollectorEndpoint('/v1/metrics') })
const logExporter = new OTLPLogExporter({ url: getCollectorEndpoint('/v1/logs') })

export const resourceAttrs = {
	[ATTR_SERVICE_NAME]: 'squad-layer-manager',
	[ATTR_SERVICE_VERSION]: formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA),
	// ATTR_SERVICE_INSTANCE_ID seems to be broken
	['service.instance.id']: `${Date.now()}-${randomBytes(4).toString('hex')}`,
}
export const sdk = new NodeSDK({
	resource: new Resource(resourceAttrs),
	traceExporter: traceExporter,
	spanProcessor: new tracing.SimpleSpanProcessor(traceExporter),
	metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter }),
	logRecordProcessors: [new logs.SimpleLogRecordProcessor(logExporter)],
	instrumentations: [getNodeAutoInstrumentations()],
})

process.on('beforeExit', async () => {
	await sdk.shutdown()
})

sdk.start()
