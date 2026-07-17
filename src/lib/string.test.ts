import { describe, expect, test } from 'vitest'

import { normalizeForMatch, simpleUniqueStringMatch } from './string'

const PYOTR = 'Пётр'
const TANAKA = 'たなか'
// escaped rather than literal: dprint normalizes the source file, which would collapse these two into one string
const JOSE_PRECOMPOSED = 'Jos\u00e9'
const JOSE_DECOMPOSED = 'Jose\u0301'

describe('normalizeForMatch', () => {
	test('keeps non-ascii', () => {
		expect(normalizeForMatch(PYOTR)).toBe(PYOTR.toLowerCase())
		expect(normalizeForMatch(TANAKA)).toBe(TANAKA)
	})

	test('folds compatibility and composition differences', () => {
		expect(JOSE_DECOMPOSED).not.toBe(JOSE_PRECOMPOSED)
		expect(normalizeForMatch(JOSE_DECOMPOSED)).toBe(normalizeForMatch(JOSE_PRECOMPOSED))
		// fullwidth tags fold to plain ascii
		expect(normalizeForMatch('ＴＡＧ')).toBe('tag')
	})

	test('folds case and whitespace', () => {
		expect(normalizeForMatch('[TAG] Bob Smith')).toBe('[tag]bobsmith')
	})
})

describe('simpleUniqueStringMatch', () => {
	const names = [PYOTR, TANAKA, 'Bob', JOSE_PRECOMPOSED]

	test('resolves a non-latin name against itself', () => {
		expect(simpleUniqueStringMatch(names, PYOTR)).toEqual({ code: 'ok', matched: 0 })
		expect(simpleUniqueStringMatch(names, TANAKA)).toEqual({ code: 'ok', matched: 1 })
	})

	test('resolves a partial non-latin name', () => {
		expect(simpleUniqueStringMatch(names, PYOTR.slice(1))).toEqual({ code: 'ok', matched: 0 })
	})

	test('resolves a name typed in a different composition form', () => {
		expect(simpleUniqueStringMatch(names, JOSE_DECOMPOSED)).toEqual({ code: 'ok', matched: 3 })
	})

	test('still distinguishes latin names', () => {
		expect(simpleUniqueStringMatch(names, 'bob')).toEqual({ code: 'ok', matched: 2 })
		expect(simpleUniqueStringMatch(names, 'zzz')).toEqual({ code: 'err:not-found' })
	})
})
