import { describe, expect, test } from 'vitest'

import * as ResultTable from './result-table'

const table: ResultTable.Table = {
	headers: ['Player', 'Matches'],
	rows: [
		['alice', '3'],
		['bob, the "builder"', '12'],
		['=HYPERLINK("http://x")', '-1'],
	],
	numeric: [false, true],
}

describe('tableCsv', () => {
	test('quotes what needs quoting, and keeps a formula-looking name text', () => {
		expect(ResultTable.tableCsv(table).split('\r\n')).toEqual([
			'Player,Matches',
			'alice,3',
			'"bob, the ""builder""",12',
			// a text cell leading with `=` gets a quote in front; a number column is left as it is
			`"'=HYPERLINK(""http://x"")",-1`,
		])
	})
})

describe('tableText', () => {
	test('lines columns up, numbers to the right', () => {
		expect(ResultTable.tableText(table).split('\n')).toEqual([
			'Player                  Matches',
			'----------------------  -------',
			'alice                         3',
			'bob, the "builder"           12',
			'=HYPERLINK("http://x")       -1',
		])
	})
})
