// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import * as Find from './subtree-find.ts'

function mount(html: string) {
	const root = document.createElement('div')
	root.innerHTML = html
	document.body.appendChild(root)
	return root
}

afterEach(() => {
	document.body.innerHTML = ''
})

function textOf(root: HTMLElement, query: string, options?: Find.SearchOptions) {
	const index = Find.buildIndex(root)
	const { matches, truncated } = Find.search(index, query, options)
	return {
		truncated,
		found: matches.map((m) => index.text.slice(m.start, m.end)),
		ranges: matches.map((m) => Find.toRange(index, m).toString()),
	}
}

describe('buildIndex', () => {
	it('joins text across inline elements and separates it across blocks', () => {
		const index = Find.buildIndex(mount('<div>foo<span>bar</span></div><div>baz</div>'))
		expect(index.text).toBe('foobar\nbaz')
	})

	it('skips subtrees that are hidden, script-like, or opted out', () => {
		const index = Find.buildIndex(
			mount(
				'<span>keep</span>' +
					'<span style="display:none">gone</span>' +
					'<span style="visibility:hidden">gone</span>' +
					'<script>gone</script>' +
					`<span ${Find.IGNORE_ATTR}>gone</span>`,
			),
		)
		expect(index.text).not.toContain('gone')
		expect(index.text).toContain('keep')
	})

	// the walk is filterless and prunes by hand, so a rejected element has to skip its whole subtree and then
	// resume at the right place -- including when it is the last child and resuming means climbing back out
	it('prunes a rejected element and resumes after it', () => {
		const index = Find.buildIndex(mount('<div>before</div><div style="display:none"><div><span>gone</span></div></div><div>after</div>'))
		expect(index.text).toBe('before\nafter')
	})

	it('prunes a rejected element nested as the last descendant', () => {
		const index = Find.buildIndex(
			mount('<div>before</div><div><div><div style="display:none"><span>gone</span></div></div></div><div>after</div>'),
		)
		expect(index.text).toBe('before\nafter')
	})

	it('collapses whitespace the way CSS renders it', () => {
		const index = Find.buildIndex(mount('<span>a  \n\t b</span>'))
		expect(index.text).toBe('a b')
	})
})

// the find bar renders inside the region it searches, so a caller watching that region for changes has to be able
// to tell its own chrome apart from the content -- otherwise the counter ticking over invalidates the index
describe('isIgnored', () => {
	it('covers the opted-out element and everything under it, and nothing else', () => {
		const root = mount(`<div id="content">text</div><div ${Find.IGNORE_ATTR}><span id="chrome">1 of 2</span></div>`)
		const chrome = root.querySelector('#chrome')!
		const content = root.querySelector('#content')!
		expect(Find.isIgnored(chrome)).toBe(true)
		expect(Find.isIgnored(chrome.firstChild!)).toBe(true)
		expect(Find.isIgnored(chrome.parentElement!)).toBe(true)
		expect(Find.isIgnored(content)).toBe(false)
		expect(Find.isIgnored(content.firstChild!)).toBe(false)
	})
})

describe('search', () => {
	it('is case insensitive by default and exact when asked', () => {
		const root = mount('<span>Alpha alpha ALPHA</span>')
		expect(textOf(root, 'alpha').found).toHaveLength(3)
		expect(textOf(root, 'alpha', { caseSensitive: true }).found).toEqual(['alpha'])
	})

	it('matches across inline elements but never across a block boundary', () => {
		const root = mount('<div>fo<b>ob</b>ar</div><div>baz</div>')
		expect(textOf(root, 'foobar').found).toEqual(['foobar'])
		expect(textOf(root, 'foobarbaz').found).toEqual([])
	})

	it('resolves a match spanning two text nodes to a range over the rendered text', () => {
		const root = mount('<div>fo<b>ob</b>ar</div>')
		expect(textOf(root, 'oba').ranges).toEqual(['oba'])
	})

	it('resolves offsets inside a node whose whitespace was collapsed', () => {
		const root = mount('<span>the   quick   brown</span>')
		expect(textOf(root, 'quick brown').ranges).toEqual(['quick   brown'])
	})

	it('honours whole-word matching', () => {
		const root = mount('<div>cat</div><div>category</div><div>a cat.</div>')
		expect(textOf(root, 'cat').found).toHaveLength(3)
		expect(textOf(root, 'cat', { wholeWord: true }).found).toHaveLength(2)
	})

	it('does not report overlapping matches', () => {
		expect(textOf(mount('<span>aaaa</span>'), 'aa').found).toHaveLength(2)
	})

	it('reports truncation once the cap is reached', () => {
		const root = mount(`<span>${'x'.repeat(50)}</span>`)
		const result = textOf(root, 'x', { maxMatches: 10 })
		expect(result.found).toHaveLength(10)
		expect(result.truncated).toBe(true)
	})

	it('finds nothing for an empty query', () => {
		expect(textOf(mount('<span>anything</span>'), '').found).toEqual([])
	})
})
