import { describe, expect, it } from 'vitest'

import * as Criteria from './criteria.ts'
import { DEFAULT_CRITERIA } from './plugin.ts'

const vars = (over: Partial<Criteria.CriteriaVars> = {}): Criteria.CriteriaVars => ({
	population: 20,
	afkPopulation: 2,
	activePopulation: 18,
	currentTime: { hour: 14, minute: 30, minutesOfDay: 870, weekday: 3 },
	...over,
})

function evaluate(expression: string, over?: Partial<Criteria.CriteriaVars>) {
	const compiled = Criteria.compile(expression)
	if (compiled.code !== 'ok') return compiled
	return compiled.evaluate(vars(over))
}

describe('compile', () => {
	it('reports a syntax error instead of throwing', () => {
		expect(Criteria.compile('population >=')).toMatchObject({ code: 'err:compile' })
	})

	it('reports a runtime error rather than quietly reading as false', () => {
		// the mistake this is here for: a plausible-looking property that does not exist reads as undefined,
		// so `population >= undefined.x` is the only shape that can actually be caught
		expect(evaluate('currentTime.nope.x > 1')).toMatchObject({ code: 'err:eval' })
	})

	it('coerces a non-boolean result', () => {
		expect(evaluate('population')).toEqual({ code: 'ok', passed: true })
		expect(evaluate('0')).toEqual({ code: 'ok', passed: false })
	})

	it('cannot see anything but its four variables', () => {
		expect(evaluate('typeof process')).toMatchObject({ code: 'ok' })
		expect(evaluate('typeof somethingUndeclared === "undefined"')).toEqual({ code: 'ok', passed: true })
	})
})

describe('the default criteria', () => {
	const inWindow = { currentTime: { hour: 14, minute: 30, minutesOfDay: 870, weekday: 3 } }
	const beforeWindow = { currentTime: { hour: 13, minute: 59, minutesOfDay: 839, weekday: 3 } }
	const afterWindow = { currentTime: { hour: 15, minute: 31, minutesOfDay: 931, weekday: 3 } }

	it('passes with enough players inside the window', () => {
		expect(evaluate(DEFAULT_CRITERIA, { population: 18, ...inWindow })).toEqual({ code: 'ok', passed: true })
	})

	it('fails one player short', () => {
		expect(evaluate(DEFAULT_CRITERIA, { population: 17, ...inWindow })).toEqual({ code: 'ok', passed: false })
	})

	it('is closed on both ends of the window', () => {
		expect(evaluate(DEFAULT_CRITERIA, { population: 30, ...beforeWindow })).toEqual({ code: 'ok', passed: false })
		expect(evaluate(DEFAULT_CRITERIA, { population: 30, ...afterWindow })).toEqual({ code: 'ok', passed: false })
		// the boundaries themselves are inside it
		expect(evaluate(DEFAULT_CRITERIA, { population: 30, currentTime: { hour: 14, minute: 0, minutesOfDay: 840, weekday: 3 } })).toEqual({
			code: 'ok',
			passed: true,
		})
		expect(evaluate(DEFAULT_CRITERIA, { population: 30, currentTime: { hour: 15, minute: 30, minutesOfDay: 930, weekday: 3 } })).toEqual({
			code: 'ok',
			passed: true,
		})
	})
})

describe('timeVars', () => {
	// 2026-07-08T18:30:00Z is 14:30 in New York on EDT, and 13:30 on EST five months later. The whole point
	// of naming a zone rather than an offset is that the window does not move between the two.
	it('reads the wall clock in the named zone, across a daylight saving change', () => {
		expect(Criteria.timeVars('America/New_York', new Date('2026-07-08T18:30:00Z'))).toMatchObject({ hour: 14, minutesOfDay: 870 })
		expect(Criteria.timeVars('America/New_York', new Date('2026-12-08T19:30:00Z'))).toMatchObject({ hour: 14, minutesOfDay: 870 })
	})

	it('numbers weekdays from Sunday', () => {
		expect(Criteria.timeVars('UTC', new Date('2026-07-05T12:00:00Z')).weekday).toBe(0)
		expect(Criteria.timeVars('UTC', new Date('2026-07-08T12:00:00Z')).weekday).toBe(3)
	})

	it('falls back to UTC on an unknown zone rather than throwing', () => {
		expect(Criteria.isValidTimezone('Mars/Olympus')).toBe(false)
		expect(Criteria.timeVars('Mars/Olympus', new Date('2026-07-08T18:30:00Z'))).toMatchObject({ hour: 18, minute: 30 })
	})
})
