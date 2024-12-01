import { beforeAll, describe, expect, test } from 'vitest'
import { AsyncResource, sleep } from './async'
import * as C from '@/server/context'
import { baseLogger, setupLogger } from '@/server/logger'
import { setupEnv } from '@/server/env'
import { Mutex } from 'async-mutex'

let ctx!: C.Log

beforeAll(() => {
	setupEnv()
	setupLogger()
	ctx = { log: baseLogger }
})

describe('AsyncResource', () => {
	test('basic fetch works', async () => {
		let count = 0
		const resource = new AsyncResource('test', async () => {
			count++
			return count
		})
		const { value } = await resource.get(ctx)
		expect(value).toBe(1)
	})

	test('ttl caches values', async () => {
		let count = 0
		const resource = new AsyncResource('test', async () => {
			count++
			return count
		})
		const { value: value1 } = await resource.get(ctx)
		const { value: value2 } = await resource.get(ctx)
		expect(value1).toBe(1)
		expect(value2).toBe(1)
		expect(count).toBe(1)
	})

	test('invalidate forces refresh', async () => {
		let count = 0
		const resource = new AsyncResource('test', async () => {
			count++
			return count
		})
		const { value: value1 } = await resource.get(ctx)
		resource.invalidate(ctx)
		const { value: value2 } = await resource.get(ctx)
		expect(value1).toBe(1)
		expect(value2).toBe(2)
		expect(count).toBe(2)
	})

	test('observe emits updates', async () => {
		let count = 0
		const resource = new AsyncResource('test', async () => {
			count++
			return count
		})

		const values: number[] = []
		const sub = resource.observe(ctx, { ttl: 10_000 }).subscribe((value) => {
			values.push(value)
		})

		await sleep(10)
		resource.invalidate(ctx)
		await sleep(10)

		expect(values).toEqual([1, 2])
		sub.unsubscribe()
	})

	test('lock prevents concurrent access', async () => {
		const resource = new AsyncResource('test', async () => {
			await sleep(55)
			return 1
		})

		const start = Date.now()
		const [result1, result2] = await Promise.all([
			resource.get(ctx, { lock: true, ttl: 0 }).then((res) => {
				res.release()
				return res.value
			}),
			resource.get(ctx, { lock: true, ttl: 0 }).then((res) => {
				res.release()
				return res.value
			}),
		])

		const elapsed = Date.now() - start
		expect(elapsed).toBeGreaterThanOrEqual(100)
		expect(result1).toBe(1)
		expect(result2).toBe(1)
	})
})
