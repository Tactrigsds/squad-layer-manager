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

	test.each(['', 'not-a-colour', '#12345', '#gg0000', 'rgb(1, 2)', 'url(evil)'])('rejects %s', (input) => {
		expect(Color.parse(input)).toBeNull()
	})
})
