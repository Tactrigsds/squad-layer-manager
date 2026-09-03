import { describe, expect, it } from 'vitest'

import { parseWithNodeComments, stringifyWithNodeComments } from './filter-text-editor.helpers'

describe('filter text mirror comments', () => {
	const tree = {
		type: 'and',
		comment: 'the whole filter',
		children: [
			{ type: 'eq', neg: false, args: [{ type: 'column', column: 'Layer' }], comment: 'why this rule exists' },
			{ type: 'or', children: [{ type: 'eq', neg: false, args: [], comment: 'deeper' }] },
		],
	}

	it('renders every comment as a # line above its node, and reads the tree back unchanged', () => {
		const text = stringifyWithNodeComments(tree, true)
		expect(text).toContain('# the whole filter\ntype: and')
		expect(text).toContain('# why this rule exists\n  - { type: eq, neg: false, args: [ { type: column, column: Layer } ] }')
		expect(text).not.toContain('comment:')
		expect(parseWithNodeComments(text)).toEqual(tree)
	})

	it('lets a # line win over a comment: typed into the buffer by hand', () => {
		const text =
			'# root\ntype: and\nchildren:\n  # from the line\n  - { type: eq, comment: from the key }\n  - { type: eq, comment: kept }\n'
		expect(parseWithNodeComments(text)).toEqual({
			type: 'and',
			comment: 'root',
			children: [
				{ type: 'eq', comment: 'from the line' },
				{ type: 'eq', comment: 'kept' },
			],
		})
	})
})
