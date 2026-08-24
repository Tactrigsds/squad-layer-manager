import { describe, expect, it } from 'vitest'

import * as CS from '@/models/context-shared'

import * as Cleanup from './cleanup'
import * as Rx from './rxjs'

function testCtx() {
	const errors: unknown[] = []
	const log = { error: (err: unknown) => errors.push(err) } as unknown as CS.Logger
	return { ctx: { ...CS.init(), log }, errors }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('runCleanup', () => {
	it('runs tasks FILO', async () => {
		const { ctx } = testCtx()
		const order: string[] = []
		await Cleanup.runCleanup(ctx, [() => void order.push('first'), () => void order.push('second'), () => void order.push('third')])
		expect(order).toEqual(['third', 'second', 'first'])
	})

	// the reason concat has to be spread and each task deferred: an async task used to be started and abandoned,
	// so runCleanup resolved before its teardown finished and the next task overlapped it
	it('awaits async tasks and runs them in sequence', async () => {
		const { ctx } = testCtx()
		const order: string[] = []
		await Cleanup.runCleanup(ctx, [
			async () => {
				order.push('slow:start')
				await sleep(30)
				order.push('slow:end')
			},
			async () => {
				order.push('quick:start')
				await sleep(1)
				order.push('quick:end')
			},
		])
		expect(order).toEqual(['quick:start', 'quick:end', 'slow:start', 'slow:end'])
	})

	it('handles each task shape', async () => {
		const { ctx } = testCtx()
		const subject = new Rx.Subject<number>()
		const controller = new AbortController()
		let unsubscribed = false
		const subscription = Rx.NEVER.pipe(Rx.tap({ unsubscribe: () => (unsubscribed = true) })).subscribe()
		let completed = false
		subject.subscribe({ complete: () => (completed = true) })

		await Cleanup.runCleanup(ctx, [subscription, subject, controller])

		expect(unsubscribed).toBe(true)
		expect(completed).toBe(true)
		expect(controller.signal.aborted).toBe(true)
	})

	// zustand's unsubscribe is `() => listeners.delete(listener)`, so every store subscription registered as a
	// cleanup task hands back Set.delete's `true`
	it('ignores a value a thunk happens to return', async () => {
		const { ctx, errors } = testCtx()
		const listeners = new Set([() => {}])
		const [listener] = listeners

		await Cleanup.runCleanup(ctx, [() => listeners.delete(listener), () => 'done', () => 0])

		expect(listeners.size).toBe(0)
		expect(errors).toEqual([])
	})

	it('recurses into nested task lists', async () => {
		const { ctx } = testCtx()
		const order: string[] = []
		await Cleanup.runCleanup(ctx, [() => void order.push('outer'), [() => void order.push('inner-a'), () => void order.push('inner-b')]])
		expect(order).toEqual(['inner-b', 'inner-a', 'outer'])
	})

	it('logs a throwing task and still runs the rest', async () => {
		const { ctx, errors } = testCtx()
		const order: string[] = []
		await Cleanup.runCleanup(ctx, [
			() => void order.push('ran'),
			() => {
				throw new Error('sync boom')
			},
		])
		expect(order).toEqual(['ran'])
		expect(errors).toHaveLength(1)
	})

	it('logs a rejecting async task and still runs the rest', async () => {
		const { ctx, errors } = testCtx()
		const order: string[] = []
		await Cleanup.runCleanup(ctx, [() => void order.push('ran'), async () => void (await Promise.reject(new Error('async boom')))])
		expect(order).toEqual(['ran'])
		expect(errors).toHaveLength(1)
	})

	// a task holds whatever its closure captured, and the list often outlives the drain
	it('drops each task once it has run, so a second drain is a no-op', async () => {
		const { ctx } = testCtx()
		let runs = 0
		const tasks: Cleanup.Tasks = [() => void runs++, () => void runs++]

		await Cleanup.runCleanup(ctx, tasks)
		expect(runs).toBe(2)
		expect(tasks).toEqual([null, null])

		await Cleanup.runCleanup(ctx, tasks)
		expect(runs).toBe(2)
	})

	it('drops a throwing task too', async () => {
		const { ctx, errors } = testCtx()
		const tasks: Cleanup.Tasks = [
			() => {
				throw new Error('boom')
			},
		]
		await Cleanup.runCleanup(ctx, tasks)
		expect(tasks).toEqual([null])
		expect(errors).toHaveLength(1)
	})
})

describe('a list registered in two places', () => {
	// how a plugin's per-server instance is torn down: whichever of the server or the plugin ends
	// first runs it, and the other must neither re-run it nor be left holding what it captured
	it('runs once, on whichever drain reaches it first', async () => {
		const { ctx } = testCtx()
		let runs = 0
		const cleanup: Cleanup.Tasks = [() => void runs++]
		const server: Cleanup.Tasks = [cleanup]
		const plugin: Cleanup.Tasks = [cleanup]

		await Cleanup.runCleanup(ctx, server)
		expect(runs).toBe(1)
		expect(cleanup).toEqual([null])

		await Cleanup.runCleanup(ctx, plugin)
		expect(runs).toBe(1)
	})

	it('empties a nested list through the outer drain', async () => {
		const { ctx } = testCtx()
		let runs = 0
		const inner: Cleanup.Tasks = [() => void runs++]
		const outer: Cleanup.Tasks = [inner]

		await Cleanup.runCleanup(ctx, outer)
		expect(runs).toBe(1)
		expect(inner).toEqual([null])
		expect(outer).toEqual([null])
	})
})
