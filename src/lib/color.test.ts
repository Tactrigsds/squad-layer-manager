import { describe, expect, test } from 'vitest'

import * as Color from '@/lib/color'

describe('parse', () => {
	test.each([
		['#22a54b', { r: 0x22, g: 0xa5, b: 0x4b }],
		['#2A5', { r: 0x22, g: 0xaa, b: 0x55 }],
		['#22a54b80', { r: 0x22, g: 0xa5, b: 0x4b }],
		['rgb(34, 165, 75)', { r: 34, g: 165, b: 75 }],
		['rgba(34 165 75 / 0.5)', { r: 34, g: 165, b: 75 }],
		['hsl(0, 100%, 50%)', { r: 255, g: 0, b: 0 }],
		['hsl(210 100% 50%)', { r: 0, g: 128, b: 255 }],
		['  GREEN ', { r: 0, g: 128, b: 0 }],
		['rebeccapurple', { r: 102, g: 51, b: 153 }],
	])('%s', (input, expected) => {
		expect(Color.parse(input)).toEqual(expected)
	})

	test.each([
		'',
		'not-a-colour',
		'#12345',
		'#gg0000',
		'rgb(1, 2)',
		'url(evil)',
		'rgb(1 2 3"/><script>fetch`/x`</script><path d="x)',
		'rgb(1 2 3 4 5)',
	])('rejects %s', (input) => {
		expect(Color.parse(input)).toBeNull()
	})
})

describe('pickDistinct', () => {
	const lab = (hex: string) => Color.toOklab(Color.parse(hex)!)
	const nearest = (hex: string, taken: string[]) => Math.min(...taken.map((t) => Color.distance(lab(hex), lab(t))))

	test('starts with the first swatch', () => {
		expect(Color.pickDistinct([])).toBe(Color.SWATCH_LIST[0])
	})

	test('skips a swatch that is merely close to a taken color, not just equal to it', () => {
		expect(Color.pickDistinct(['#d04858'])).toBe(Color.SWATCHES.orange)
	})

	test('ignores unparseable taken colors', () => {
		expect(Color.pickDistinct(['not-a-colour'])).toBe(Color.SWATCH_LIST[0])
	})

	test('keeps its distance once the swatches run out', () => {
		const taken = [...Color.SWATCH_LIST]
		for (let i = 0; i < 8; i++) {
			const next = Color.pickDistinct(taken)
			expect(next).toMatch(/^#[0-9a-f]{6}$/)
			expect(nearest(next, taken)).toBeGreaterThan(0.05)
			taken.push(next)
		}
	})

	test('fills in around arbitrary taken colors', () => {
		const taken = ['#ff0000', '#0000ff', '#00ff00', '#ffff00']
		expect(nearest(Color.pickDistinct(taken), taken)).toBeGreaterThanOrEqual(0.1)
	})
})
