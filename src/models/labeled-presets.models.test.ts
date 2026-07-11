import * as LP from '@/models/labeled-presets.models'
import { describe, expect, it } from 'vitest'

function preset(label: string, aliases: string[] = []): LP.LabeledPreset {
	return { label, message: `${label} message`, aliases }
}

describe('findByLabelOrAlias', () => {
	const presets = [preset('Seeding', ['seed']), preset('Live', ['golive'])]

	it('matches labels and aliases case-insensitively', () => {
		expect(LP.findByLabelOrAlias(presets, 'seeding')?.label).toBe('Seeding')
		expect(LP.findByLabelOrAlias(presets, 'SEED')?.label).toBe('Seeding')
		expect(LP.findByLabelOrAlias(presets, 'nope')).toBeUndefined()
	})
})

describe('BroadcastPresetsSchema uniqueness', () => {
	it('rejects an alias colliding with another preset label', () => {
		const res = LP.BroadcastPresetsSchema.safeParse([preset('Seeding'), preset('Live', ['seeding'])])
		expect(res.success).toBe(false)
	})

	it('accepts distinct labels/aliases', () => {
		expect(LP.BroadcastPresetsSchema.safeParse([preset('Seeding', ['seed']), preset('Live')]).success).toBe(true)
	})
})

describe('didYouMean', () => {
	it('returns the closest candidate', () => {
		expect(LP.didYouMean('sed', LP.labelAliasStrings([preset('Seeding', ['seed']), preset('Live')]))).toBe('seed')
	})

	it('returns undefined with no candidates', () => {
		expect(LP.didYouMean('x', [])).toBeUndefined()
	})
})
