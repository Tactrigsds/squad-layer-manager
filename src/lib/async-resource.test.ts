import * as Otel from '@opentelemetry/api'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import * as GCtx from '@/lib/generic-ctx'

import { AsyncResource } from './async-resource'
import type { OtelModule } from './otel'
import * as Rx from './rxjs'

const module: OtelModule = {
	name: 'test',
	tracer: Otel.trace.getTracer('test'),
	getLogger: () => pino({ level: 'silent' }),
	spanOp:
		(_name, _opts, cb) =>
		async (...args) =>
			await cb(...args),
	child: () => module,
}

describe('AsyncResource.observe', () => {
	it('replays the value cached at subscribe time, not at observe() time', async () => {
		let fetches = 0
		const res = new AsyncResource<number>('counter', async () => ++fetches, module, {})
		const ctx = GCtx.init()

		expect(await res.get(ctx)).toBe(1)
		const value$ = res.observe(ctx)
		res.invalidate(ctx)
		expect(await res.get(ctx)).toBe(2)

		expect(await Rx.firstValueFrom(value$)).toBe(2)
		res.dispose()
	})
})
