import * as Otel from '@opentelemetry/api'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import * as CS from '@/models/context-shared'

import { AsyncResource } from './async-resource'
import * as Rx from './rxjs'

const module = { name: 'test', tracer: Otel.trace.getTracer('test'), getLogger: () => pino({ level: 'silent' }) }

describe('AsyncResource.observe', () => {
	it('replays the value cached at subscribe time, not at observe() time', async () => {
		let fetches = 0
		const res = new AsyncResource<number>('counter', async () => ++fetches, module, {})
		const ctx = CS.init()

		expect(await res.get(ctx)).toBe(1)
		const value$ = res.observe(ctx)
		res.invalidate(ctx)
		expect(await res.get(ctx)).toBe(2)

		expect(await Rx.firstValueFrom(value$)).toBe(2)
		res.dispose()
	})
})
