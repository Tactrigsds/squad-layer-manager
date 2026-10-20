import { describe, expect, it, vi } from 'vitest'

import { createBatchLoader } from '@/lib/batch-loader'

describe('createBatchLoader', () => {
	it('fetches every key asked for in one tick as one batch, and starts a new batch after it', async () => {
		const fetchMany = vi.fn(async (keys: string[]) => new Map(keys.map((key) => [key, key.toUpperCase()])))
		const load = createBatchLoader(fetchMany)

		const first = await Promise.all([load('a'), load('b'), load('a')])
		expect(first).toEqual(['A', 'B', 'A'])
		expect(fetchMany).toHaveBeenCalledTimes(1)
		expect(fetchMany.mock.calls[0][0]).toEqual(['a', 'b'])

		expect(await load('c')).toBe('C')
		expect(fetchMany).toHaveBeenCalledTimes(2)
	})

	it('answers undefined for a key the fetch left out, and rejects every caller when the fetch fails', async () => {
		const load = createBatchLoader(async (keys: string[]) => new Map(keys.filter((key) => key !== 'gone').map((key) => [key, 1])))
		expect(await Promise.all([load('here'), load('gone')])).toEqual([1, undefined])

		const failing = createBatchLoader(async () => {
			throw new Error('down')
		})
		await expect(Promise.all([failing('a'), failing('b')])).rejects.toThrow('down')
	})
})
