import { describe, expect, test } from 'vitest'

import * as SM from '@/models/squad.models'
import { splitBroadcast } from '@/systems/squad-rcon.server'

const PREFIX = 'AdminBroadcast '

function expectSendable(chunks: string[]) {
	for (const chunk of chunks) {
		expect(Buffer.byteLength(PREFIX + chunk, 'utf8')).toBeLessThanOrEqual(SM.RCON_MAX_BUF_LEN)
		expect(chunk.isWellFormed()).toBe(true)
	}
}

describe('splitBroadcast', () => {
	test('leaves a message within the limit whole', () => {
		const message = 'first paragraph\n\nsecond paragraph'
		expect(splitBroadcast(message)).toEqual([message])
	})

	test('keeps every line of a paragraph over the limit', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i} `.padEnd(60, 'x'))
		const paragraph = lines.join('\n')
		const chunks = splitBroadcast(`intro\n\n${paragraph}`)

		expectSendable(chunks)
		expect(chunks[0]).toBe('intro')
		expect(chunks.length).toBe(4)
		expect(chunks.slice(1).join('\n')).toBe(paragraph)
	})

	test('measures the limit in utf-8 bytes', () => {
		const lines = Array.from({ length: 60 }, () => 'Привет, мир! '.repeat(4))
		const message = lines.join('\n')
		expect(message.length).toBeLessThan(SM.RCON_MAX_BUF_LEN)

		const chunks = splitBroadcast(message)
		expectSendable(chunks)
		expect(chunks.length).toBe(2)
		expect(chunks.join('\n')).toBe(message)
	})

	test('truncates a single oversize line on a character boundary', () => {
		const line = 'a' + '😀'.repeat(2000)
		const [chunk, ...rest] = splitBroadcast(line)

		expectSendable([chunk])
		expect(rest).toEqual([])
		expect(line.startsWith(chunk)).toBe(true)
		expect(Buffer.byteLength(PREFIX + chunk, 'utf8')).toBeGreaterThan(SM.RCON_MAX_BUF_LEN - 4)
	})
})
