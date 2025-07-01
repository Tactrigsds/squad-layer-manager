import * as CS from '@/models/context-shared'
import { ensureEnvSetup } from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import { beforeAll, describe, expect, test } from 'vitest'
import { AsyncResource, sleep } from './async'

let ctx!: CS.Log

beforeAll(() => {
	ensureEnvSetup()
	ensureLoggerSetup()
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
		const sub = resource.observe(ctx, { ttl: 25 }).subscribe((value) => {
			values.push(value)
		})

		await sleep(100)

		expect(values.slice(0, 2)).toEqual([1, 2])
		sub.unsubscribe()
	})

	test('invalidation emits updates for all observers', async () => {
		let count = 0
		const resource = new AsyncResource(
			'test',
			async () => {
				count++
				return count
			},
			{ defaultTTL: 10_000 },
		)

		const values: number[] = []

		const sub = resource.observe(ctx, { ttl: 10_000 }).subscribe((value) => {
			values.push(value)
		})

		await sleep(100)
		resource.invalidate(ctx)
		await sleep(0)
		resource.invalidate(ctx)
		await sleep(0)

		expect(values).toEqual([1, 2, 3])

		sub.unsubscribe()
	})
})
