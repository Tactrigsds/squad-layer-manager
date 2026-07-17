import { runDetectingYield } from '@/server/db'
import { describe, expect, test } from 'vitest'

// what an awaited drizzle query looks like to the runtime: better-sqlite3 runs the statement synchronously, and the
// query builder is a thenable that resolves from inside .then() rather than from an IO completion
function syncThenable<T>(value: T): PromiseLike<T> {
	return { then: (resolve, reject) => Promise.resolve().then(() => resolve!(value), reject) }
}

describe('runDetectingYield', () => {
	test('a callback that only awaits queries does not yield', async () => {
		const { res, yielded } = await runDetectingYield(async () => {
			const a = await syncThenable(1)
			const b = await syncThenable(2)
			return a + b
		})
		expect(res).toBe(3)
		expect(yielded).toBe(false)
	})

	test('awaiting settled promises and draining microtasks does not count as yielding', async () => {
		// a long microtask chain never hands control back to the event loop, so no other transaction can interleave
		// with it -- it is CPU-bound, not a lock-holding wait, and must not be reported
		const { yielded } = await runDetectingYield(async () => {
			for (let i = 0; i < 500; i++) await Promise.resolve()
			await queueMicrotaskP()
		})
		expect(yielded).toBe(false)
	})

	test('a timer yields', async () => {
		const { yielded } = await runDetectingYield(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1))
		})
		expect(yielded).toBe(true)
	})

	test('real IO yields', async () => {
		const { yielded } = await runDetectingYield(async () => {
			await import('node:fs/promises').then((fs) => fs.readFile(import.meta.filename, 'utf8'))
		})
		expect(yielded).toBe(true)
	})

	test('reports the yield rather than swallowing the callback failure', async () => {
		await expect(runDetectingYield(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1))
			throw new Error('boom')
		})).rejects.toThrow('boom')
	})
})

function queueMicrotaskP() {
	return new Promise<void>((resolve) => queueMicrotask(resolve))
}
