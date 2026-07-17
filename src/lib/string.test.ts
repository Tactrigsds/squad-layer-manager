import { describe, expect, test } from 'vitest'

import { normalizeForMatch, simpleUniqueStringMatch } from './string'

const PYOTR = 'Пётр'
const TANAKA = 'たなか'
const JOSE_PRECOMPOSED = 'José'
const JOSE_DECOMPOSED = 'José'

describe('normalizeForMatch', () => {
	test('keeps non-ascii by default', () => {
		expect(normalizeForMatch(PYOTR)).toBe(PYOTR.toLowerCase())
		expect(normalizeForMatch(TANAKA)).toBe(TANAKA)
	})

	test('folds compatibility and composition differences', () => {
		expect(JOSE_DECOMPOSED).not.toBe(JOSE_PRECOMPOSED)
		expect(normalizeForMatch(JOSE_DECOMPOSED)).toBe(normalizeForMatch(JOSE_PRECOMPOSED))
		// fullwidth tags fold to plain ascii
		expect(normalizeForMatch('ＴＡＧ')).toBe('tag')
	})

	test('strips whitespace and case in both modes', () => {
		expect(normalizeForMatch('[TAG] Bob Smith')).toBe('[tag]bobsmith')
		expect(normalizeForMatch('[TAG] Bob Smith', { stripNonAscii: true })).toBe('[tag]bobsmith')
	})

	test('stripNonAscii discards everything outside printable ascii', () => {
		expect(normalizeForMatch(PYOTR, { stripNonAscii: true })).toBe('')
		expect(normalizeForMatch(`Ivan ${PYOTR}`, { stripNonAscii: true })).toBe('ivan')
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

	// the reason stripNonAscii is off by default: stripping leaves an empty needle, which every name contains
	test('stripNonAscii makes a non-latin name match everything', () => {
		expect(simpleUniqueStringMatch(names, PYOTR, { stripNonAscii: true })).toEqual({
			code: 'err:multiple-matches',
			count: names.length,
		})
	})

	test('still distinguishes latin names', () => {
		expect(simpleUniqueStringMatch(names, 'bob')).toEqual({ code: 'ok', matched: 2 })
		expect(simpleUniqueStringMatch(names, 'zzz')).toEqual({ code: 'err:not-found' })
	})
})
