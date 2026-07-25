import { describe, expect, it } from 'vitest'
import * as SC from './server-console.models'

describe('splitChunk', () => {
	it('holds back a line the chunk cut in half until the rest arrives', () => {
		const first = SC.splitChunk('', 'complete line\nhalf a li')
		expect(first.lines).toEqual(['complete line'])
		expect(first.partial).toBe('half a li')

		const second = SC.splitChunk(first.partial, 'ne\n')
		expect(second.lines).toEqual(['half a line'])
		expect(second.partial).toBe('')
	})

	it('drops the carriage return a windows-written log leaves behind', () => {
		expect(SC.splitChunk('', 'a line\r\n').lines).toEqual(['a line'])
	})

	it('ignores blank lines rather than printing them as entries', () => {
		expect(SC.splitChunk('', 'a\n\n   \nb\n').lines).toEqual(['a', 'b'])
	})

	it('emits nothing for a chunk with no newline in it at all', () => {
		const res = SC.splitChunk('', 'no newline yet')
		expect(res.lines).toEqual([])
		expect(res.partial).toBe('no newline yet')
	})
})
