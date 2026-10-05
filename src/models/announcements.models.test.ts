import { describe, expect, it } from 'vitest'

import * as ANN from '@/models/announcements.models'

describe('parseMessage', () => {
	it('splits countdown tokens out of the text, ending them relative to sentAt', () => {
		expect(ANN.parseMessage('SLM restarts in {countdown:2m} to update', 1000)).toEqual([
			{ type: 'text', text: 'SLM restarts in ' },
			{ type: 'countdown', durationMs: 120_000, endsAt: 121_000 },
			{ type: 'text', text: ' to update' },
		])
	})

	it('leaves a token with an unparseable duration as text', () => {
		expect(ANN.parseMessage('{countdown:soon} or {countdown:30s}', 0)).toEqual([
			{ type: 'text', text: '{countdown:soon} or ' },
			{ type: 'countdown', durationMs: 30_000, endsAt: 30_000 },
		])
	})

	it('renders the full duration for one-shot destinations', () => {
		expect(ANN.renderStatic(ANN.parseMessage('restart in {countdown:90s}', 0))).toBe('restart in 1m 30s')
	})
})
