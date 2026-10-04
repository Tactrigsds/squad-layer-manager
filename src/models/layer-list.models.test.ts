import { describe, expect, it } from 'vitest'

import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'

describe('LL.movesToOrder', () => {
	const source: LL.Source = { type: 'manual', userId: 1n }
	const ids = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee', 'ffffff', 'gggggg']

	function apply(current: string[], target: string[]) {
		const list: LL.List = current.map((itemId) => ({ type: 'single-list-item', itemId, layerId: L.DEFAULT_LAYER_ID, source }))
		const moves = LL.movesToOrder(current, target)
		for (const move of moves) LL.moveItem(list, source, move.itemId, LL.createItemId(), move.cursor)
		return { order: list.map((item) => item.itemId), moves: moves.length }
	}

	it('reaches every permutation in the fewest moves', () => {
		let seed = 3
		const next = (n: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed % n
		}
		for (let trial = 0; trial < 500; trial++) {
			const n = 1 + next(ids.length)
			const current = ids.slice(0, n)
			const target = [...current]
			for (let i = n - 1; i > 0; i--) {
				const j = next(i + 1)
				;[target[i], target[j]] = [target[j], target[i]]
			}
			// the fewest single moves is n minus the longest run already in order
			let longest = 0
			const run = new Array(n).fill(1)
			for (let b = 0; b < n; b++) {
				for (let a = 0; a < b; a++) {
					if (current.indexOf(target[a]) < current.indexOf(target[b])) run[b] = Math.max(run[b], run[a] + 1)
				}
				longest = Math.max(longest, run[b])
			}
			const res = apply(current, target)
			expect(res.order).toEqual(target)
			expect(res.moves).toBe(n - longest)
		}
	})
})
