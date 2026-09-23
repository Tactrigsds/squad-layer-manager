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

describe('quoteContent', () => {
	test('a code block per quote, holding the text alone', () => {
		expect(DM.quoteContent(['a\nb', 'c'], note)).toEqual({ content: '```\na\nb\n```\n```\nc\n```', files: [] })
	})

	test('the quotes share the message length, and one cut short comes whole as a file', () => {
		const long = lines(300).join('\n')
		const { content, files } = DM.quoteContent([long, 'short'], note)
		expect(content.length).toBeLessThanOrEqual(DM.MESSAGE_CONTENT_LIMIT)
		expect(files).toEqual([{ name: 'selection-1.txt', text: long }])
		expect(content.endsWith('```\nshort\n```')).toBe(true)
	})
})
