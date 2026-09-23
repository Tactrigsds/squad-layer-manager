import { describe, expect, test } from 'vitest'

import * as DM from './discord.models'

const note = (n: number) => `${n} more`
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(20)}`)
const body = (block: string) => /```\n([\s\S]*)\n```/.exec(block)![1].split('\n')

describe('codeBlock', () => {
	test('keeps short text whole', () => {
		expect(DM.codeBlock('a\nb', 100, note)).toEqual({ block: '```\na\nb\n```', truncated: false })
	})

	test('cuts long text at a line boundary, inside the limit, and says how much it left out', () => {
		const all = lines(200)
		const res = DM.codeBlock(all.join('\n'), 2000, note)
		expect(res.truncated).toBe(true)
		expect(res.block.length).toBeLessThanOrEqual(2000)
		const kept = body(res.block)
		expect(kept).toEqual(all.slice(0, kept.length))
		expect(res.block.endsWith(`\n\`\`\`\n${200 - kept.length} more`)).toBe(true)
	})

	test('a fence in the text does not close the block', () => {
		expect(DM.codeBlock('look ``` here', 100, note).block.match(/```/g)).toHaveLength(2)
	})
})

describe('quoteEmbeds', () => {
	test('an embed per quote, holding the text alone', () => {
		const { embeds, files } = DM.quoteEmbeds(['a\nb'], note)
		expect(embeds).toEqual([{ description: '```\na\nb\n```' }])
		expect(files).toEqual([])
	})

	test('the quotes share the message budget, and one cut short comes whole as a file', () => {
		const long = lines(300).join('\n')
		const { embeds, files } = DM.quoteEmbeds([long, 'short'], note)
		const total = embeds.reduce((sum, e) => sum + e.description!.length, 0)
		expect(total).toBeLessThanOrEqual(DM.EMBEDS_TOTAL_LIMIT)
		for (const embed of embeds) expect(embed.description!.length).toBeLessThanOrEqual(DM.EMBED_DESCRIPTION_LIMIT)
		expect(files).toEqual([{ name: 'selection-1.txt', text: long }])
		expect(embeds[1].description).toBe('```\nshort\n```')
	})
})
