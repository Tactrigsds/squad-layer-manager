import { StandardRPCJsonSerializer } from '@orpc/client/standard'
import { describe, expect, it } from 'vitest'

import { FastRPCJsonSerializer } from './orpc-json-serializer'

const stock = new StandardRPCJsonSerializer()
const fast = new FastRPCJsonSerializer()

function expectSameWire(value: unknown) {
	const [stockJson, stockMeta, stockMaps, stockBlobs] = stock.serialize(value)
	const [fastJson, fastMeta, fastMaps, fastBlobs] = fast.serialize(value)
	expect(JSON.stringify(fastJson)).toEqual(JSON.stringify(stockJson))
	expect(fastMeta).toEqual(stockMeta)
	expect(fastMaps).toEqual(stockMaps)
	expect(fastBlobs).toEqual(stockBlobs)
	const roundTripped = stock.deserialize(JSON.parse(JSON.stringify(fastJson) ?? 'null'), fastMeta)
	expect(roundTripped).toEqual(stock.deserialize(JSON.parse(JSON.stringify(stockJson) ?? 'null'), stockMeta))
}

class Point {
	constructor(
		public x: number,
		public y: number,
	) {}
}

describe('FastRPCJsonSerializer', () => {
	it('writes the same json and meta as the stock serializer', () => {
		const cases: unknown[] = [
			null,
			undefined,
			0,
			Number.NaN,
			Infinity,
			'str',
			true,
			123n,
			new Date(0),
			new Date(Number.NaN),
			new URL('https://example.com/a?b=c'),
			/ab+c/gi,
			new Set([1, 2n, new Date(5)]),
			new Map<unknown, unknown>([
				['a', 1n],
				[2n, { d: new Date(1) }],
			]),
			[1, undefined, 3, null, [undefined, 4n]],
			// holes: alone, beside a copied element, and trailing
			// oxlint-disable-next-line no-sparse-arrays
			[1, , 3],
			// oxlint-disable-next-line no-sparse-arrays
			[4n, , undefined, ,],
			{ a: undefined, b: 1, c: { d: 2n, e: [new Date(2), 'x'] } },
			{ a: 1, toJSON: () => 'nope', b: 2n },
			{ toJSON: () => 'nope', a: 1 },
			Object.assign(Object.create(null), { a: 1n, b: 'x' }),
			{ point: new Point(1, 2), n: Number.NaN },
			{ deep: { deeper: { deepest: [{ id: 1n }, { id: 2n, at: new Date(3) }] } } },
			{ fn: () => 1, sym: Symbol('s'), arr: [() => 1] },
		]
		for (const value of cases) expectSameWire(value)
	})

	it('returns plain JSON values by reference', () => {
		const value = { a: [1, 'two', { three: true, four: null }], b: { c: 'd' } }
		const [json, meta] = fast.serialize(value)
		expect(json).toBe(value)
		expect(meta).toEqual([])
	})

	it('copies only the subtrees that changed', () => {
		const unchanged = { name: 'x', tags: ['a', 'b'] }
		const value = { unchanged, changed: { id: 5n }, list: [unchanged, { at: new Date(0) }] }
		const [json] = fast.serialize(value) as [typeof value, ...unknown[]]
		expect(json).not.toBe(value)
		expect(json.unchanged).toBe(unchanged)
		expect(json.list[0]).toBe(unchanged)
		expect(value.changed.id).toBe(5n)
	})

	it('matches the stock serializer on random values', () => {
		let seed = 1
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31
			return seed / 2 ** 31
		}
		const leaf = (): unknown => {
			const leaves = [() => 1, () => 'x', () => true, () => null, () => undefined, () => 7n, () => new Date(9), () => Number.NaN]
			return leaves[Math.floor(rand() * leaves.length)]()
		}
		const gen = (depth: number): unknown => {
			const r = rand()
			if (depth > 4 || r < 0.4) return leaf()
			if (r < 0.6) return Array.from({ length: Math.floor(rand() * 5) }, () => gen(depth + 1))
			if (r < 0.65) return new Set(Array.from({ length: 3 }, () => gen(depth + 1)))
			if (r < 0.7) return new Map(Array.from({ length: 2 }, (_, i) => [`k${i}`, gen(depth + 1)]))
			const obj: Record<string, unknown> = {}
			for (let i = 0; i < rand() * 6; i++) obj[`k${i}`] = gen(depth + 1)
			return obj
		}
		for (let i = 0; i < 500; i++) expectSameWire(gen(0))
	})
})
