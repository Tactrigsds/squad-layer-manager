import { describe, expect, test } from 'vitest'

import * as Str from './string-utils'

const PYOTR = 'Пётр'
const TANAKA = 'たなか'
// escaped rather than literal: oxfmt normalizes the source file, which would collapse these two into one string
const JOSE_PRECOMPOSED = 'Jos\u00e9'
const JOSE_DECOMPOSED = 'Jose\u0301'

describe('Str.normalizeForMatch', () => {
	test('keeps non-ascii', () => {
		expect(Str.normalizeForMatch(PYOTR)).toBe(PYOTR.toLowerCase())
		expect(Str.normalizeForMatch(TANAKA)).toBe(TANAKA)
	})

	test('folds compatibility and composition differences', () => {
		expect(JOSE_DECOMPOSED).not.toBe(JOSE_PRECOMPOSED)
		expect(Str.normalizeForMatch(JOSE_DECOMPOSED)).toBe(Str.normalizeForMatch(JOSE_PRECOMPOSED))
		// fullwidth tags fold to plain ascii
		expect(Str.normalizeForMatch('ＴＡＧ')).toBe('tag')
	})

	test('folds case and whitespace', () => {
		expect(Str.normalizeForMatch('[TAG] Bob Smith')).toBe('[tag]bobsmith')
	})
})

describe('Str.simpleUniqueStringMatch', () => {
	const names = [PYOTR, TANAKA, 'Bob', JOSE_PRECOMPOSED]

	test('resolves a non-latin name against itself', () => {
		expect(Str.simpleUniqueStringMatch(names, PYOTR)).toEqual({ code: 'ok', matched: 0 })
		expect(Str.simpleUniqueStringMatch(names, TANAKA)).toEqual({ code: 'ok', matched: 1 })
	})

	test('resolves a partial non-latin name', () => {
		expect(Str.simpleUniqueStringMatch(names, PYOTR.slice(1))).toEqual({ code: 'ok', matched: 0 })
	})

	test('resolves a name typed in a different composition form', () => {
		expect(Str.simpleUniqueStringMatch(names, JOSE_DECOMPOSED)).toEqual({ code: 'ok', matched: 3 })
	})

	test('still distinguishes latin names', () => {
		expect(Str.simpleUniqueStringMatch(names, 'bob')).toEqual({ code: 'ok', matched: 2 })
		expect(Str.simpleUniqueStringMatch(names, 'zzz')).toEqual({ code: 'err:not-found' })
	})
})
