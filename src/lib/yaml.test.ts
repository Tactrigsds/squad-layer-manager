import { describe, expect, it } from 'vitest'

import * as Yaml from '@/lib/yaml'

// The settings YAML editor keeps comments as real `#` lines. What matters is that a comment survives a
// stringify/parse cycle unchanged whichever key it sits on, and that hand-typed variants read back cleanly.
describe('Yaml path comments', () => {
	const value = { vote: { voteDuration: '2m', reminder: '30s' }, requireReasonFor: ['kick'], locale: 'en' }

	it('renders a comment above its key and reads it back, at the root and inside a section', () => {
		const comments = { vote: 'tuned for weekday pop', 'vote.voteDuration': 'dropped from 3m', locale: 'players are german' }
		const text = Yaml.stringifyDocWithComments(value, comments)
		expect(text).toContain('# dropped from 3m\n  voteDuration: 2m')
		expect(Yaml.parseWithComments(text)).toEqual({ value, comments })
	})

	it('keeps a commented collection in block form under compact rendering, and collapses the rest', () => {
		const text = Yaml.stringifyDocWithComments(value, { 'vote.reminder': 'x' })
		expect(text).toContain('vote:\n  voteDuration: 2m\n  # x\n  reminder: 30s')
		expect(text).toMatch(/requireReasonFor: \[ ?kick ?\]/)
	})

	it('round-trips a multi-line comment with a blank line in it', () => {
		const comments = { locale: 'first\n\nafter a blank' }
		expect(Yaml.parseWithComments(Yaml.stringifyDocWithComments(value, comments)).comments).toEqual(comments)
	})

	it('reads hand-written comments however they are spaced, and ignores one that trails the document', () => {
		const text = 'vote:\n  #no space\n  voteDuration: 2m\n#\n# bare line above\nlocale: en\n# trailing\n'
		expect(Yaml.parseWithComments(text).comments).toEqual({ 'vote.voteDuration': 'no space', locale: 'bare line above' })
	})

	it('drops a comment whose key is gone', () => {
		const text = Yaml.stringifyDocWithComments(value, { 'vote.gone': 'stale', locale: 'kept' })
		expect(Yaml.parseWithComments(text).comments).toEqual({ locale: 'kept' })
	})
})

// The filter text mirror puts a node's comment above the node, which is a sequence item wherever the node is not the
// root. The item keeps its compact form: the comment sits on the line above, not inside it.
describe('Yaml comments on sequence items', () => {
	const value = {
		type: 'and',
		children: [
			{ type: 'eq', column: 'Layer' },
			{ type: 'or', children: [{ type: 'eq', column: 'Map' }] },
		],
	}

	it('renders a comment above its item and reads it back, at any depth', () => {
		const comments = { 'children.0': 'why this rule exists', 'children.1.children.0': 'and this one' }
		const text = Yaml.stringifyDocWithComments(value, comments)
		expect(text).toContain('# why this rule exists\n  - { type: eq, column: Layer }')
		expect(Yaml.parseWithComments(text)).toEqual({ value, comments })
	})

	it('reads a hand-written comment above a later item, and one above a key inside an item', () => {
		const text = 'type: and\nchildren:\n  - { type: eq }\n  # second\n  - type: or\n    # inner\n    children: []\n'
		expect(Yaml.parseWithComments(text).comments).toEqual({ 'children.1': 'second', 'children.1.children': 'inner' })
	})
})
