import { describe, expect, it } from 'vitest'

import { type Task, TaskScheduler } from './task-scheduler'

type Gate = { promise: Promise<void>; open: () => void }
function gate(): Gate {
	let open!: () => void
	const promise = new Promise<void>((resolve) => (open = resolve))
	return { promise, open }
}

function setup() {
	const order: string[] = []
	const errors: string[] = []
	const scheduler = new TaskScheduler((_error, task) => errors.push(task.id))
	const gates = new Map<string, Gate>()
	function task(id: string, priority: number, opts: { barrier?: boolean; run?: Task['run'] } = {}): Task {
		const g = gate()
		gates.set(id, g)
		return {
			id,
			priority,
			barrier: opts.barrier ?? false,
			run:
				opts.run ??
				(async () => {
					order.push(id)
					await g.promise
				}),
		}
	}
	async function finish(id: string) {
		gates.get(id)!.open()
		// the scheduler moves on after the run promise and its catch/finally settle
		for (let i = 0; i < 5; i++) await Promise.resolve()
	}
	return { scheduler, order, errors, task, finish }
}

describe('TaskScheduler', () => {
	it('starts a task immediately when idle and runs the rest by priority, earliest first on ties', async () => {
		const { scheduler, order, task, finish } = setup()
		scheduler.enqueue(task('a', 5))
		scheduler.enqueue(task('b', 3))
		scheduler.enqueue(task('c', 1))
		scheduler.enqueue(task('d', 3))
		expect(order).toEqual(['a'])
		await finish('a')
		await finish('c')
		await finish('b')
		await finish('d')
		expect(order).toEqual(['a', 'c', 'b', 'd'])
	})

	it('keeps tasks on their side of a barrier regardless of priority', async () => {
		const { scheduler, order, task, finish } = setup()
		scheduler.enqueue(task('running', 0))
		scheduler.enqueue(task('before-low', 9))
		scheduler.enqueue(task('barrier', 5, { barrier: true }))
		scheduler.enqueue(task('after-high', 0))
		scheduler.enqueue(task('before-high', 1))
		await finish('running')
		await finish('before-low')
		await finish('barrier')
		await finish('after-high')
		await finish('before-high')
		expect(order).toEqual(['running', 'before-low', 'barrier', 'after-high', 'before-high'])
	})

	it('runs consecutive barriers in arrival order', async () => {
		const { scheduler, order, task, finish } = setup()
		scheduler.enqueue(task('running', 0))
		scheduler.enqueue(task('b1', 9, { barrier: true }))
		scheduler.enqueue(task('b2', 0, { barrier: true }))
		scheduler.enqueue(task('q', 0))
		for (const id of ['running', 'b1', 'b2', 'q']) await finish(id)
		expect(order).toEqual(['running', 'b1', 'b2', 'q'])
	})

	it('drops a cancelled pending task', async () => {
		const { scheduler, order, task, finish } = setup()
		scheduler.enqueue(task('a', 0))
		scheduler.enqueue(task('b', 0))
		scheduler.enqueue(task('c', 0))
		expect(scheduler.cancel('b')).toBe(true)
		expect(scheduler.cancel('missing')).toBe(false)
		await finish('a')
		await finish('c')
		expect(order).toEqual(['a', 'c'])
		expect(scheduler.pendingIds).toEqual([])
	})

	it('aborts the running task and moves on once it returns', async () => {
		const { scheduler, order, task, finish } = setup()
		let observedAbort = false
		scheduler.enqueue(
			task('stream', 0, {
				run: async (signal) => {
					order.push('stream')
					await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
					observedAbort = signal.aborted
				},
			}),
		)
		scheduler.enqueue(task('next', 0))
		expect(scheduler.runningId).toBe('stream')
		expect(scheduler.cancel('stream')).toBe(true)
		await finish('stream')
		expect(observedAbort).toBe(true)
		expect(scheduler.runningId).toBe('next')
		await finish('next')
		expect(order).toEqual(['stream', 'next'])
	})

	it('reports a failed task and continues', async () => {
		const { scheduler, order, errors, task, finish } = setup()
		scheduler.enqueue(
			task('sync-throw', 0, {
				run: () => {
					throw new Error('boom')
				},
			}),
		)
		scheduler.enqueue(
			task('async-throw', 0, {
				run: async () => {
					throw new Error('boom')
				},
			}),
		)
		scheduler.enqueue(task('ok', 0))
		await finish('sync-throw')
		await finish('async-throw')
		await finish('ok')
		expect(errors).toEqual(['sync-throw', 'async-throw'])
		expect(order).toEqual(['ok'])
	})
})
