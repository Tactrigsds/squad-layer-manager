import { describe, expect, test } from 'vitest'

import * as DM from './discord.models'

const note = (n: number) => `${n} more`

describe('codeBlockMessage', () => {
	test('keeps short text whole', () => {
		const res = DM.codeBlockMessage('2 events', 'a\nb', note)
		expect(res).toEqual({ content: '2 events\n```\na\nb\n```', truncated: false })
	})

	test('cuts long text at a line boundary, inside the limit, and says how much it left out', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`)
		const res = DM.codeBlockMessage('200 events', lines.join('\n'), note)
		expect(res.truncated).toBe(true)
		expect(res.content.length).toBeLessThanOrEqual(DM.MESSAGE_LIMIT)
		const body = /```\n([\s\S]*)\n```/.exec(res.content)![1].split('\n')
		expect(body).toEqual(lines.slice(0, body.length))
		expect(res.content.endsWith(`\n\`\`\`\n${200 - body.length} more`)).toBe(true)
	})

	test('a fence in the text does not close the block', () => {
		const res = DM.codeBlockMessage('1 event', 'look ``` here', note)
		expect(res.content.match(/```/g)).toHaveLength(2)
	})
})
