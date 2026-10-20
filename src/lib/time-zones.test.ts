import { describe, expect, test } from 'vitest'

import * as TZ from './time-zones'

describe('TZ wall inputs', () => {
	test('round-trips in a zone other than the process zone', () => {
		const time = Date.UTC(2026, 9, 12, 8, 30)
		expect(TZ.toWallInput(time, 'Europe/Berlin')).toBe('2026-10-12T10:30')
		expect(TZ.fromWallInput('2026-10-12T10:30', 'Europe/Berlin')).toBe(time)
		expect(TZ.fromWallInput('2026-10-12T08:30', 'UTC')).toBe(time)
	})

	test('reads a wall time on either side of a DST change at its own offset', () => {
		// Europe/Berlin leaves CEST (+2) for CET (+1) at 2026-10-25 03:00 local
		expect(TZ.fromWallInput('2026-10-24T12:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 24, 10, 0))
		expect(TZ.fromWallInput('2026-10-26T12:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 26, 11, 0))
	})

	test('resolves a wall time skipped by DST past the gap', () => {
		// America/New_York skips 02:00-03:00 on 2026-03-08
		const time = TZ.fromWallInput('2026-03-08T02:30', 'America/New_York')!
		expect(TZ.toWallInput(time, 'America/New_York')).toBe('2026-03-08T03:30')
	})

	test('rejects what a datetime-local input does not produce', () => {
		expect(TZ.fromWallInput('2026-10-12', 'UTC')).toBeUndefined()
	})
})

describe('TZ.formatFull', () => {
	test('names the IANA zone where its short name differs', () => {
		const time = Date.UTC(2026, 9, 12, 8, 30)
		expect(TZ.formatFull(time, 'UTC')).toBe('2026-10-12 08:30:00 UTC')
		expect(TZ.formatFull(time, 'Europe/Berlin')).toBe('2026-10-12 10:30:00 GMT+2 (Europe/Berlin)')
		expect(TZ.formatFull(time, 'Europe/Berlin', false)).toBe('2026-10-12 10:30:00 GMT+2')
	})
})
