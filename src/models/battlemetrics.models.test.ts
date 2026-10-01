import { describe, expect, test } from 'vitest'

import * as BM from './battlemetrics.models'

const createdAt = '2026-09-30T12:00:00.000Z'

function parse(note: string, bmUserName: string | null = 'SLM Bot') {
	return BM.parseNote({ id: '1', note, createdAt }, bmUserName)
}

describe('parseNote', () => {
	test('credits an admin note to the user who signed it', () => {
		const note = BM.playerNote({ actor: BM.webActorLabel({ displayName: 'grey (he/him)', discordId: 123n }), text: ' mic spam\ntwice ' })
		expect(parse(note)).toEqual({
			id: '1',
			createdAt: Date.parse(createdAt),
			author: { kind: 'slm', name: 'grey (he/him)' },
			text: 'mic spam\ntwice',
		})
	})

	test('reads flag change notes, with and without a reason', () => {
		const withReason = BM.flagChangeNote({ action: 'added', flagName: 'Toxic', actor: 'Moose (Steam 7656)', reason: 'slurs' })
		expect(parse(withReason)).toMatchObject({
			author: { kind: 'slm', name: 'Moose' },
			flagChange: { action: 'added', flagName: 'Toxic' },
			text: 'slurs',
		})
		const bare = BM.flagChangeNote({ action: 'removed', flagName: 'Watchlist', actor: 'Moose (Steam 7656)' })
		expect(parse(bare)).toMatchObject({ flagChange: { action: 'removed', flagName: 'Watchlist' }, text: '' })
	})

	test('leaves a note written on BattleMetrics to its BM author', () => {
		expect(parse('Note by someone via SLM but not really', 'Hyrax')).toMatchObject({
			author: { kind: 'bm', name: 'Hyrax' },
			text: 'Note by someone via SLM but not really',
		})
	})
})

describe('isPublicNote', () => {
	const now = Date.parse(createdAt)
	const base = { note: 'x', createdAt, shared: true }

	test('passes only shared, unrestricted, unexpired notes', () => {
		expect(BM.isPublicNote(base, now)).toBe(true)
		expect(BM.isPublicNote({ ...base, shared: false }, now)).toBe(false)
		expect(BM.isPublicNote({ ...base, clearanceLevel: 2 }, now)).toBe(false)
		expect(BM.isPublicNote({ ...base, clearanceLevel: 0, expiresAt: null }, now)).toBe(true)
		expect(BM.isPublicNote({ ...base, expiresAt: '2026-09-01T00:00:00.000Z' }, now)).toBe(false)
	})
})
