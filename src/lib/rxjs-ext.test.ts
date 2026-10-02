import { describe, expect, it } from 'vitest'

import * as Rx from './rxjs'

describe('toAsyncGenerator', () => {
	it('releases a quiet source when the signal aborts, without waiting for an emission', async () => {
		const source = new Rx.Subject<number>()
		const ac = new AbortController()
		const it = Rx.Ext.toAsyncGenerator(source.pipe(Rx.Ext.withAbortSignal(ac.signal)))
		const pending = it.next()
		await Promise.resolve()
		expect(source.observed).toBe(true)

		ac.abort()
		expect(source.observed).toBe(false)
		expect(await pending).toEqual({ done: true, value: undefined })
	})

	it('yields buffered values in order and ends on complete', async () => {
		const source = new Rx.Subject<number>()
		const it = Rx.Ext.toAsyncGenerator(source)
		const first = it.next()
		source.next(1)
		source.next(2)
		source.complete()
		expect(await first).toEqual({ done: false, value: 1 })
		expect(await it.next()).toEqual({ done: false, value: 2 })
		expect(await it.next()).toEqual({ done: true, value: undefined })
	})
})

describe('distinctDeepEquals', () => {
	it('compares against the previous value of the same subscription only', () => {
		const source = new Rx.Subject<{ n: number }>()
		const deduped = source.pipe(Rx.Ext.distinctDeepEquals())
		const a: number[] = []
		const b: number[] = []
		deduped.subscribe((v) => a.push(v.n))
		source.next({ n: 1 })
		source.next({ n: 1 })
		deduped.subscribe((v) => b.push(v.n))
		source.next({ n: 1 })
		source.next({ n: 2 })
		expect(a).toEqual([1, 2])
		expect(b).toEqual([1, 2])
	})
})
