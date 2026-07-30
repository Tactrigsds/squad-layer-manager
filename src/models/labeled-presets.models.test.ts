import { describe, expect, it } from 'vitest'

import * as LP from '@/models/labeled-presets.models'

function preset(label: string, keywords: string[] = []): LP.LabeledPreset {
	return { label, keywords }
}

describe('findByKeyword', () => {
	const presets = [preset('Seeding', ['seed']), preset('Live', ['golive'])]

	it('matches keywords case-insensitively', () => {
		expect(LP.findByKeyword(presets, 'SEED')?.label).toBe('Seeding')
		expect(LP.findByKeyword(presets, 'nope')).toBeUndefined()
	})

	it('does not match labels', () => {
		expect(LP.findByKeyword(presets, 'seeding')).toBeUndefined()
	})
})

describe('keywordFromLabel', () => {
	it('lowercases and dashes anything that is not a letter or digit', () => {
		expect(LP.keywordFromLabel('Teamkilling')).toBe('teamkilling')
		expect(LP.keywordFromLabel('No SLKit!')).toBe('no-slkit')
		expect(LP.keywordFromLabel('  ')).toBe('')
	})
})

describe('addLabelKeywordUniquenessIssues', () => {
	const schema = (presets: LP.LabeledPreset[]) =>
		LP.LabeledPresetSchema.array().superRefine(LP.addLabelKeywordUniquenessIssues).safeParse(presets)

	it('rejects duplicate keywords across presets', () => {
		expect(schema([preset('Seeding', ['seed']), preset('Live', ['SEED'])]).success).toBe(false)
	})

	it('accepts a keyword matching another preset label, since labels are not matched in chat', () => {
		expect(schema([preset('Seeding', ['seeding-msg']), preset('Live', ['seeding'])]).success).toBe(true)
	})

	it('requires at least one keyword', () => {
		expect(schema([preset('Seeding')]).success).toBe(false)
	})
})
