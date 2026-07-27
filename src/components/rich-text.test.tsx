// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { RichText } from './rich-text.tsx'

afterEach(cleanup)

function renderText(node: React.ReactElement) {
	const { container } = render(node)
	const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
	return { text: container.textContent, links }
}

describe('RichText', () => {
	it('links bare urls and leaves the rest literal', () => {
		const { text, links } = renderText(<RichText text="see https://example.com/a for <b>details</b>" />)
		expect(links).toEqual(['https://example.com/a'])
		expect(text).toBe('see https://example.com/a for <b>details</b>')
	})

	it('leaves trailing punctuation out of the href', () => {
		const { text, links } = renderText(<RichText text="see https://example.com/a." />)
		expect(links).toEqual(['https://example.com/a'])
		expect(text).toBe('see https://example.com/a.')
	})

	it('ignores schemes other than http(s)', () => {
		expect(renderText(<RichText text="javascript:alert(1) and ftp://example.com" />).links).toEqual([])
	})

	it('keeps a url the limit cuts short as literal text', () => {
		const { text, links } = renderText(<RichText text="padding padding https://example.com/a-long-path" maxLength={20} />)
		expect(links).toEqual([])
		expect(text).toBe('padding padding http…')
	})

	it('links a url that fits inside the limit', () => {
		const { text, links } = renderText(<RichText text="https://example.com and more text after it" maxLength={25} />)
		expect(links).toEqual(['https://example.com'])
		expect(text).toBe('https://example.com and m…')
	})

	it('does not truncate text within the limit', () => {
		expect(renderText(<RichText text="short" maxLength={20} />).text).toBe('short')
	})
})
