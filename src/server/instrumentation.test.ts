import * as Otel from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, test } from 'vitest'

import type { OtelModule } from '@/lib/otel'
import * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as Instr from '@/server/instrumentation'

// A real in-memory tracer, so these can assert on what actually landed on the span. Under the no-op
// tracer there are no spans and no active span, and every assertion here passes vacuously.
const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
const noopLogger: any = new Proxy(() => {}, { get: () => noopLogger, apply: () => undefined })
const module: OtelModule = { name: 'instrumentation-test', tracer: provider.getTracer('test'), getLogger: () => noopLogger }

function spanContext(spanId: string): Otel.SpanContext {
	return { traceId: '0'.repeat(31) + '1', spanId: '0'.repeat(15) + spanId, traceFlags: Otel.TraceFlags.SAMPLED }
}

function ctxWithLink(): CS.Otel {
	return { ...CS.init(), otel: { links: [{ context: spanContext('1'), attributes: { [ATTRS.SpanLink.SOURCE]: 'event.emitter' } }] } }
}

function linkSources() {
	return exporter.getFinishedSpans().flatMap((s) => s.links.map((l) => l.attributes?.[ATTRS.SpanLink.SOURCE]))
}

beforeEach(() => exporter.reset())

describe('spanOp links', () => {
	test('carries a link off the ctx onto the span', async () => {
		await Instr.spanOp('op', { module }, async (_c: CS.Otel) => {})(ctxWithLink())
		expect(linkSources()).toEqual(['event.emitter'])
	})

	// durableSub always passes a sub-initializer link, so this is the normal path rather than an edge
	// case: if opts.links suppresses the ctx link, no event handler ever gets one.
	test('keeps a ctx link when the op already carries one of a different source', async () => {
		const opts = { module, links: [{ context: spanContext('2'), attributes: { [ATTRS.SpanLink.SOURCE]: 'sub-initializer' } }] }
		await Instr.spanOp('op', opts, async (_c: CS.Otel) => {})(ctxWithLink())
		expect([...linkSources()].sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['event.emitter', 'sub-initializer'])
	})

	test('an explicitly passed link of the same source wins over the ctx one', async () => {
		const explicit = { context: spanContext('3'), attributes: { [ATTRS.SpanLink.SOURCE]: 'event.emitter' } }
		await Instr.spanOp('op', { module, links: [explicit] }, async (_c: CS.Otel) => {})(ctxWithLink())
		const spans = exporter.getFinishedSpans()
		expect(spans[0].links).toHaveLength(1)
		expect(spans[0].links[0].context.spanId).toBe(explicit.context.spanId)
	})
})

// A ctx carrying a link is routinely shared: an Rx.Subject hands one value to every subscriber, and
// squad-server's event$ has fourteen subscription sites. spanOp must not clear the links on the
// object it was handed, or whichever op ran first would take the link away from the rest.
describe('spanOp does not mutate the ctx it was given', () => {
	test('the original keeps its links', async () => {
		const ctx = ctxWithLink()
		await Instr.spanOp('op', { module }, async (_c: CS.Otel) => {})(ctx)
		expect(ctx.otel.links).toHaveLength(1)
	})

	test('two consumers of one shared ctx both get the link', async () => {
		const shared = ctxWithLink()
		const op = Instr.spanOp('op', { module }, async (_c: CS.Otel) => {})
		await op(shared)
		await op(shared)
		expect(linkSources()).toEqual(['event.emitter', 'event.emitter'])
	})

	test('the callback receives a spent ctx, so a nested op does not re-link', async () => {
		let inner: readonly unknown[] | undefined
		await Instr.spanOp('outer', { module }, async (c: CS.Otel) => {
			inner = c.otel.links
		})(ctxWithLink())
		expect(inner).toEqual([])
	})
})
