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

describe('dueOccurrence, match-relative', () => {
	const M = 60_000
	const inProgress: SJOB.MatchTimes = { status: 'in-progress', startTime: 100 * M }
	const postGame: SJOB.MatchTimes = { status: 'post-game', endTime: 100 * M }

	it('runs once `after` the boundary, and only in the phase it follows', () => {
		const spec = SJOB.afterMatchStart('5m')
		expect(SJOB.dueOccurrence(spec, 104 * M, M, null, inProgress)).toBeNull()
		expect(SJOB.dueOccurrence(spec, 105 * M, M, null, inProgress)).toBe(105 * M)
		expect(SJOB.dueOccurrence(spec, 106 * M, M, { dueAt: 105 * M, finishedAt: 105 * M }, inProgress)).toBeNull()
		expect(SJOB.dueOccurrence(spec, 105 * M, M, null, postGame)).toBeNull()
		expect(SJOB.dueOccurrence(SJOB.afterMatchEnd('0s'), 100 * M, M, null, postGame)).toBe(100 * M)
		expect(SJOB.dueOccurrence(SJOB.afterMatchEnd('0s'), 100 * M, M, null, inProgress)).toBeNull()
	})

	it('repeats on a grid from the first run, catching up only the latest within the window', () => {
		const spec = SJOB.afterMatchStart('0s', { every: '10m' })
		expect(SJOB.dueOccurrence(spec, 125 * M, 10 * M, { dueAt: 100 * M, finishedAt: 100 * M }, inProgress)).toBe(120 * M)
		expect(SJOB.dueOccurrence(spec, 125 * M, M, { dueAt: 100 * M, finishedAt: 100 * M }, inProgress)).toBeNull()
		expect(SJOB.nextOccurrence(spec, 125 * M, null, inProgress)).toBe(130 * M)
	})

	it('waits for the boundary while the match is in the other phase', () => {
		expect(SJOB.nextOccurrence(SJOB.afterMatchEnd('1m'), 100 * M, null, inProgress)).toBeNull()
		expect(SJOB.awaitedBoundary(SJOB.afterMatchEnd('1m'), inProgress)).toBe('end')
		expect(SJOB.awaitedBoundary(SJOB.afterMatchEnd('1m'), postGame)).toBeNull()
		expect(SJOB.nextOccurrence(SJOB.afterMatchEnd('1m'), 100 * M, null, postGame)).toBe(101 * M)
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
