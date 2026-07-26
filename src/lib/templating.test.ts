import { describe, expect, it } from 'vitest'

import { renderTemplate } from '@/lib/templating'

describe('renderTemplate', () => {
	it('substitutes variables without HTML-escaping', () => {
		expect(renderTemplate('See {{discord}} & more', { discord: 'discord.gg/x' })).toBe('See discord.gg/x & more')
	})

	it('renders unknown variables as empty', () => {
		expect(renderTemplate('a{{missing}}b', {})).toBe('ab')
	})

	it('falls back to the raw string on a malformed template', () => {
		const bad = 'hello {{#unclosed}}'
		expect(renderTemplate(bad, {})).toBe(bad)
	})
})
