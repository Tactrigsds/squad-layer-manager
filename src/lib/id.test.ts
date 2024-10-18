import { describe, expect, it } from 'vitest'

import { createId } from './id'

describe('createId', () => {
	it('generates an ID with the specified length', () => {
		const id = createId(10)
		expect(id).toHaveLength(10)
	})

	it('generates unique IDs', () => {
		const id1 = createId(20)
		const id2 = createId(20)
		expect(id1).not.toBe(id2)
	})

	it('generates URL-safe IDs', () => {
		const id = createId(30)
		expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
	})

	it('generates IDs with expected character set', () => {
		const id = createId(100)
		const validChars = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-')
		for (const char of id) {
			expect(validChars.has(char)).toBe(true)
		}
	})

	it('generates IDs of different lengths', () => {
		const id5 = createId(5)
		const id15 = createId(15)
		const id50 = createId(50)
		expect(id5).toHaveLength(5)
		expect(id15).toHaveLength(15)
		expect(id50).toHaveLength(50)
	})
})
