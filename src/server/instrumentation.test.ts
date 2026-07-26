import * as Otel from '@opentelemetry/api'
import { describe, expect, test } from 'vitest'

import type { OtelModule } from '@/lib/otel'
import * as CS from '@/models/context-shared'
import * as Instr from '@/server/instrumentation'

// a stub rather than initModule: the real one reaches for baseLogger, which needs env setup
const noopLogger: any = new Proxy(() => {}, { get: () => noopLogger, apply: () => undefined })
const module: OtelModule = { name: 'instrumentation-test', tracer: Otel.trace.getTracer('test'), getLogger: () => noopLogger }

// A ctx carrying a link is routinely shared: an Rx.Subject hands one value to every subscriber, and
// squad-server's event$ has fourteen subscription sites. spanOp must therefore not clear the links
// on the object it was handed, or whichever op ran first would take the link away from the rest.
describe('spanOp link handling', () => {
	// a synthetic link rather than storeLinkToActiveSpan: there is no SDK here, so there is no active
	// span and every assertion below would be on an empty array
	function ctxWithLink(): CS.Otel {
		const context: Otel.SpanContext = { traceId: '0'.repeat(31) + '1', spanId: '0'.repeat(15) + '1', traceFlags: Otel.TraceFlags.SAMPLED }
		return { ...CS.init(), otel: { links: [{ context }] } }
	}

	test('does not mutate the ctx it was given', async () => {
		const ctx = ctxWithLink()
		await Instr.spanOp('noop', { module }, async (_c: CS.Otel) => {})(ctx)
		expect(ctx.otel.links).toHaveLength(1)
	})

	test('two consumers of one shared ctx both see the links', async () => {
		const shared = ctxWithLink()
		const seen: number[] = []
		const observe = Instr.spanOp('observe', { module }, async (c: CS.Otel) => {
			seen.push(c.otel.links.length)
		})
		// each consumer is handed the same object; the first must not spend the link for the second
		await observe(shared)
		await observe(shared)
		// both saw a spent ctx, and crucially the shared original is untouched for any later subscriber
		expect(seen).toEqual([0, 0])
		expect(shared.otel.links).toHaveLength(1)
	})

	test('the callback receives a spent ctx, so a nested op does not re-link', async () => {
		const ctx = ctxWithLink()
		let inner: readonly unknown[] | undefined
		await Instr.spanOp('outer', { module }, async (c: CS.Otel) => {
			inner = c.otel.links
		})(ctx)
		expect(inner).toEqual([])
	})
})
