import type * as Otel from '@opentelemetry/api'
import type { MutexInterface } from 'async-mutex'
import type pino from 'pino'

export type SpanOpOpts<Cb extends (...args: any[]) => any> = {
	links?: Otel.Link[]
	// defaults to INTERNAL. Set CLIENT on egress (rcon, http, sftp) and SERVER on ingress: span kind
	// is what a service graph and any spanmetrics connector key off, so leaving everything INTERNAL
	// means we get neither out of spans we're already paying to export.
	kind?: Otel.SpanKind
	levels?: {
		event?: pino.Level | ((...args: Parameters<Cb>) => pino.Level)
		error?: pino.Level | ((...args: Parameters<Cb>) => pino.Level)
		valueError?: pino.Level | ((...args: Parameters<Cb>) => pino.Level)
	}
	root?: boolean
	attrs?: Record<string, any> | ((...args: Parameters<Cb>) => Record<string, any>)
	extraText?: (...args: Parameters<Cb>) => string
	mutexes?: (...args: Parameters<Cb>) => MutexInterface[] | MutexInterface
}

export type SpanOp = <Cb extends (...args: any[]) => any>(
	name: string,
	opts: SpanOpOpts<Cb>,
	cb: Cb,
) => (...args: Parameters<Cb>) => Promise<Awaited<ReturnType<Cb>>>

/**
 * A named telemetry scope. The server builds these (server/instrumentation.ts, createModule) and binds its own
 * spanOp to them, so code in src/lib can open spans through a module it is handed without importing the server.
 */
export type OtelModule = {
	name: string
	tracer: Otel.Tracer
	getLogger(): pino.Logger
	spanOp: SpanOp
	child(submoduleName: string): OtelModule
}
