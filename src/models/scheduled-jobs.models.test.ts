import { describe, expect, it } from 'vitest'

import * as SJOB from './scheduled-jobs.models'

const at = (iso: string) => Date.parse(iso)
const H = 60 * 60_000
// Saturday 12:00 in New York
const saturdayNoon = SJOB.weekly(6, '12:00', 'America/New_York')

describe('dueOccurrence, cron', () => {
	it('runs the occurrence that has just come due', () => {
		expect(SJOB.dueOccurrence(saturdayNoon, at('2026-10-10T16:00:30Z'), 12 * H, null)).toBe(at('2026-10-10T16:00:00Z'))
	})

	it('counts an occurrence due at exactly now', () => {
		expect(SJOB.dueOccurrence(saturdayNoon, at('2026-10-10T16:00:00Z'), 12 * H, null)).toBe(at('2026-10-10T16:00:00Z'))
	})

	it('catches up only within the window, and only once', () => {
		const lateInWindow = at('2026-10-11T03:00:00Z')
		expect(SJOB.dueOccurrence(saturdayNoon, lateInWindow, 12 * H, null)).toBe(at('2026-10-10T16:00:00Z'))
		expect(SJOB.dueOccurrence(saturdayNoon, lateInWindow, 12 * H, { dueAt: at('2026-10-10T16:00:00Z'), finishedAt: null })).toBeNull()
		expect(SJOB.dueOccurrence(saturdayNoon, at('2026-10-11T05:00:00Z'), 12 * H, null)).toBeNull()
	})

	it('runs only the latest of several missed occurrences', () => {
		const daily = SJOB.daily('08:00', 'UTC')
		const threeDaysLate = at('2026-10-15T09:00:00Z')
		expect(SJOB.dueOccurrence(daily, threeDaysLate, 7 * 24 * H, { dueAt: at('2026-10-12T08:00:00Z'), finishedAt: 1 })).toBe(
			at('2026-10-15T08:00:00Z'),
		)
	})

	it('reads the time of day across a daylight-saving change', () => {
		// 12:00 EST, after the autumn change
		expect(SJOB.dueOccurrence(saturdayNoon, at('2026-11-07T17:00:10Z'), H, null)).toBe(at('2026-11-07T17:00:00Z'))
		expect(SJOB.nextOccurrence(saturdayNoon, at('2026-10-31T17:00:00Z'), null)).toBe(at('2026-11-07T17:00:00Z'))
	})
})

describe('dueOccurrence, interval', () => {
	const every = { every: '6h' }

	it('runs straight away when it has never run', () => {
		expect(SJOB.dueOccurrence(every, 1000, 0, null)).toBe(1000)
	})

	it('anchors to the last finish, and never overlaps a run still going', () => {
		expect(SJOB.dueOccurrence(every, 7 * H, 0, { dueAt: 0, finishedAt: H })).toBe(7 * H)
		expect(SJOB.dueOccurrence(every, 7 * H - 1, 0, { dueAt: 0, finishedAt: H })).toBeNull()
		expect(SJOB.dueOccurrence(every, 100 * H, 0, { dueAt: 0, finishedAt: null })).toBeNull()
	})
})

describe('specs', () => {
	it('rejects a malformed time, cron or interval', () => {
		expect(() => SJOB.weekly(6, '25:00', 'UTC')).toThrow()
		expect(SJOB.specError({ cron: 'not a cron', timezone: 'UTC' })).not.toBeNull()
		expect(SJOB.specError({ every: '0s' })).not.toBeNull()
		expect(SJOB.specError(saturdayNoon)).toBeNull()
	})

	it('backs off retries from a minute, doubling to ten', () => {
		expect([1, 2, 3, 4, 5, 9].map(SJOB.retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
	})
})
