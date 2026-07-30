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

// the one ranking behind every "did you mean" in the app: the numbered choices an in-game argument is answered
// with, and the single suggestion an unknown command gets
describe('Str.nearest', () => {
	test('ranks by closeness, ignoring what a caller plausibly varies', () => {
		// "Alice" is one of Alice_The_Great's words, so it outranks Alicia despite the longer whole name
		expect(Str.nearest('alise', ['Alice_The_Great', 'Bob', 'Alicia'], 3)).toEqual(['Alice_The_Great', 'Alicia'])
		// a clan tag is scored against separately, so it does not drown out the name the caller aimed at
		expect(Str.nearest('alice', ['[7CAV] Alice_G', 'Charlie'], 3)[0]).toBe('[7CAV] Alice_G')
	})

	test('offers a shortening, which scores its length over the whole word', () => {
		expect(Str.nearest('mod', ['moderation', 'votes', 'flags'], 3)).toEqual(['moderation'])
	})

	test('offers nothing when nothing is close, which is what leaves the plain error in place', () => {
		expect(Str.nearest('zzzzz', ['Alice', 'Bob'], 3)).toEqual([])
	})

	test('prefers being the word to merely containing it', () => {
		// both hold "Gorodok" as a word and so score the same on it; the map is what was meant
		expect(Str.nearest('gorodokk', ['Gorodok_AAS_v1', 'Gorodok'], 2)).toEqual(['Gorodok', 'Gorodok_AAS_v1'])
	})

	test('keeps to the limit it is given', () => {
		expect(Str.nearest('alise', ['Alice_The_Great', 'Alicia'], 1)).toEqual(['Alice_The_Great'])
	})

	test('ranks items by whatever text they carry', () => {
		const squads = [{ squadName: 'Alpha' }, { squadName: 'Bravo' }]
		expect(Str.nearestBy('alpa', squads, (s) => s.squadName, 3)).toEqual([{ squadName: 'Alpha' }])
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
