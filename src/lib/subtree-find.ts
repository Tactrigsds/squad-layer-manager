// Ctrl+F over one subtree. The whole point is that nothing here touches React or the DOM's shape: matches are
// painted with the CSS Custom Highlight API, which takes ranges and paints them during the browser's own text
// rendering, so a query over thousands of matches costs zero nodes, zero reflows and zero component renders.

export type Match = Readonly<{ start: number; end: number }>

// The subtree's rendered text, flattened into one string. `starts[i]` is where node `i`'s text begins in it, so a
// match offset maps back to a node by binary search. `normalized` marks the nodes whose whitespace was collapsed
// on the way in, which are the only ones needing the slower offset walk in `toStaticRange`.
export type Index = Readonly<{
	root: Element
	text: string
	nodes: readonly Text[]
	starts: Uint32Array
	normalized: Uint8Array
}>

export type SearchOptions = Readonly<{
	caseSensitive?: boolean
	wholeWord?: boolean
	maxMatches?: number
}>

export type SearchResult = Readonly<{ matches: Match[]; truncated: boolean }>

// Ranges are cheap but painting is not, and past a few thousand matches the count stops meaning anything to a
// reader anyway. Callers report the cap as "N+" rather than pretending everything was found.
export const MAX_MATCHES = 5000

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS', 'OBJECT'])

/** Opts an element and its subtree out of every find bar above it. */
export const IGNORE_ATTR = 'data-find-ignore'
const IGNORE_SELECTOR = `[${IGNORE_ATTR}]`

/**
 * Whether a node sits in a subtree opted out of indexing. Callers watching the region for changes need this as
 * well: text that is never indexed changing is not a change to what was searched.
 */
export function isIgnored(node: Node) {
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
	return !!el?.closest(IGNORE_SELECTOR)
}

export function isSupported() {
	return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

function isCollapsible(code: number) {
	return code === 32 || code === 9 || code === 10 || code === 13 || code === 12
}

// Text with no run of collapsible whitespace and no nbsp already reads the way CSS renders it, so it passes
// through untouched and keeps offset parity with the node's own data. That is the overwhelmingly common case.
const NEEDS_NORMALIZE = /[\t\n\r\f\u00A0]| {2}/

function normalizeText(raw: string) {
	// nbsp is not collapsible, but a reader typing a space means to match one
	return raw.replace(/[ \t\n\r\f]+/g, ' ').replace(/\u00A0/g, ' ')
}

const INLINE_TAGS = new Set([
	'A',
	'ABBR',
	'B',
	'BDI',
	'BDO',
	'BIG',
	'CITE',
	'CODE',
	'DATA',
	'DFN',
	'EM',
	'FONT',
	'I',
	'KBD',
	'MARK',
	'NOBR',
	'Q',
	'RP',
	'RT',
	'RUBY',
	'S',
	'SAMP',
	'SMALL',
	'SPAN',
	'STRONG',
	'SUB',
	'SUP',
	'TIME',
	'TT',
	'U',
	'VAR',
	'WBR',
])

// Whether text either side of this element's box runs continuously into it. Anything else is its own box, so text
// on either side is separated -- matching what the browser's own find does, and what a reader sees. A subtree the
// browser has not laid out reports no computed display at all, so the element's default stands in.
function isTextContinuous(el: Element, display: string) {
	if (display === '') return INLINE_TAGS.has(el.tagName)
	return display === 'inline' || display === 'contents' || display.startsWith('ruby')
}

// Returns false for an element whose subtree holds nothing a reader can see, and otherwise records which block box
// its text belongs to. Every ancestor up to the root has already passed, so `blocks` has an entry for the parent.
function acceptElement(el: Element, blocks: Map<Element, Element>, root: Element) {
	if (SKIPPED_TAGS.has(el.tagName)) return false
	if (el.hasAttribute(IGNORE_ATTR)) return false
	const style = getComputedStyle(el)
	if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
	if (style.contentVisibility === 'hidden') return false
	const parent = el.parentElement
	const inherited = el !== root && parent && isTextContinuous(el, style.display) ? blocks.get(parent) : undefined
	blocks.set(el, inherited ?? el)
	return true
}

/** Advances past the current node's entire subtree, which is what a filter's FILTER_REJECT would have done. */
function skipSubtree(walker: TreeWalker) {
	let next = walker.nextSibling()
	while (next === null) {
		if (walker.parentNode() === null) return null
		next = walker.nextSibling()
	}
	return next
}

export function buildIndex(root: Element): Index {
	const blocks = new Map<Element, Element>([[root, root]])
	// deliberately filterless. A TreeWalker calls a JS `acceptNode` across the C++ boundary once per node, which
	// costs more than everything the callback would do: on a 12k-node subtree the same walk measures 0.6ms bare
	// against 10.8ms with a filter that only returns ACCEPT. Rejection is done by hand instead, in skipSubtree.
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)

	const nodes: Text[] = []
	const starts: number[] = []
	const normalized: number[] = []
	const segments: string[] = []
	let offset = 0
	let prevBlock: Element | null = null

	let node = walker.nextNode()
	while (node !== null) {
		if (node.nodeType !== Node.TEXT_NODE) {
			node = acceptElement(node as Element, blocks, root) ? walker.nextNode() : skipSubtree(walker)
			continue
		}
		const text = node as Text
		node = walker.nextNode()

		const raw = text.data
		if (raw.length === 0) continue
		const needs = NEEDS_NORMALIZE.test(raw)
		const value = needs ? normalizeText(raw) : raw
		if (value.length === 0) continue

		const block = blocks.get(text.parentElement!) ?? root
		// a newline nobody can type keeps a match from spanning two boxes that are only adjacent in the flattened text
		if (prevBlock !== null && block !== prevBlock) {
			segments.push('\n')
			offset += 1
		}
		prevBlock = block

		nodes.push(text)
		starts.push(offset)
		normalized.push(needs ? 1 : 0)
		segments.push(value)
		offset += value.length
	}

	return {
		root,
		text: segments.join(''),
		nodes,
		starts: Uint32Array.from(starts),
		normalized: Uint8Array.from(normalized),
	}
}

// Lowercasing the whole index once beats lowercasing per search, and is only sound while it preserves length: a
// handful of code points (ẞ, İ) grow when lowered, which would shift every offset after them. An index like that
// caches `null` and falls back to a case-insensitive RegExp, whose offsets are into the original text and so
// cannot drift.
const lowerCache = new WeakMap<Index, string | null>()

function lowerFor(index: Index): string | null {
	if (lowerCache.has(index)) return lowerCache.get(index)!
	const lower = index.text.toLowerCase()
	const usable = lower.length === index.text.length ? lower : null
	lowerCache.set(index, usable)
	return usable
}

function escapeRegExp(source: string) {
	return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// \w plus everything above ASCII, so accented and non-latin text is not read as a word boundary
function isWordChar(code: number) {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code > 127
}

function atWordBoundary(text: string, start: number, end: number) {
	const before = start > 0 ? text.charCodeAt(start - 1) : 0
	const after = end < text.length ? text.charCodeAt(end) : 0
	return !isWordChar(before) && !isWordChar(after)
}

export function search(index: Index, query: string, options: SearchOptions = {}): SearchResult {
	// the separator is the one character the flattened text holds that no match may span
	const needle = query.replace(/\n/g, ' ')
	const limit = options.maxMatches ?? MAX_MATCHES
	if (needle.length === 0 || index.nodes.length === 0) return { matches: [], truncated: false }

	const matches: Match[] = []
	// matches do not overlap, the same as the browser's own find
	const collect = (start: number) => {
		const end = start + needle.length
		if (!options.wholeWord || atWordBoundary(index.text, start, end)) matches.push({ start, end })
		return matches.length < limit
	}

	const haystack = options.caseSensitive ? index.text : lowerFor(index)
	if (haystack !== null) {
		const target = options.caseSensitive ? needle : needle.toLowerCase()
		for (let at = haystack.indexOf(target); at !== -1; at = haystack.indexOf(target, at + needle.length)) {
			if (!collect(at)) return { matches, truncated: true }
		}
		return { matches, truncated: false }
	}

	const pattern = new RegExp(escapeRegExp(needle), 'gi')
	for (let m = pattern.exec(index.text); m; m = pattern.exec(index.text)) {
		if (!collect(m.index)) return { matches, truncated: true }
	}
	return { matches, truncated: false }
}

/** Index of the node holding `offset`, or the preceding node when the offset lands in a block separator. */
function nodeAt(index: Index, offset: number) {
	const { starts } = index
	let lo = 0
	let hi = starts.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (starts[mid] <= offset) lo = mid
		else hi = mid - 1
	}
	return lo
}

// Walks the node's own data counting the normalized positions it produces, so a collapsed run of whitespace maps
// back to the run's first character.
function rawOffset(raw: string, target: number) {
	let normalized = 0
	for (let i = 0; i < raw.length; i++) {
		if (normalized === target) return i
		if (isCollapsible(raw.charCodeAt(i))) {
			while (i + 1 < raw.length && isCollapsible(raw.charCodeAt(i + 1))) i++
		}
		normalized++
	}
	return raw.length
}

function localOffset(index: Index, i: number, offset: number) {
	const node = index.nodes[i]
	const local = offset - index.starts[i]
	if (index.normalized[i]) return rawOffset(node.data, local)
	return Math.min(Math.max(local, 0), node.data.length)
}

export function boundaries(index: Index, match: Match) {
	// the end offset is exclusive, so it is resolved against the node holding the match's last character
	const si = nodeAt(index, match.start)
	const ei = nodeAt(index, match.end - 1)
	return {
		startContainer: index.nodes[si],
		startOffset: localOffset(index, si, match.start),
		endContainer: index.nodes[ei],
		endOffset: localOffset(index, ei, match.end),
	}
}

// StaticRange rather than Range: a live Range registers with the document and is re-anchored on every mutation,
// which is exactly the per-match cost this module exists to avoid. Highlights never need liveness -- a stale index
// is rebuilt and repainted wholesale.
export function toStaticRange(index: Index, match: Match): StaticRange {
	return new StaticRange(boundaries(index, match))
}

/** A live range, for the one match that has to be measured and scrolled to. */
export function toRange(index: Index, match: Match): Range {
	const { startContainer, startOffset, endContainer, endOffset } = boundaries(index, match)
	const range = document.createRange()
	range.setStart(startContainer, startOffset)
	range.setEnd(endContainer, endOffset)
	return range
}

export function paint(name: string, ranges: readonly AbstractRange[], priority = 0) {
	if (!isSupported()) return
	if (ranges.length === 0) {
		CSS.highlights.delete(name)
		return
	}
	const highlight = new Highlight(...(ranges as AbstractRange[]))
	highlight.priority = priority
	CSS.highlights.set(name, highlight)
}

export function clear(...names: string[]) {
	if (!isSupported()) return
	for (const name of names) CSS.highlights.delete(name)
}

// `hidden` counts: it establishes a scrolling box that no scrollbar reaches but `scrollTop` still moves, which is
// what a container clipping its overflow without offering a bar is. Only `visible` and `clip` never scroll.
const SCROLLABLE_OVERFLOW = /^(auto|scroll|overlay|hidden)$/

function scrollableAxes(el: Element) {
	if (el === document.documentElement) return { y: true, x: true }
	const style = getComputedStyle(el)
	return {
		y: SCROLLABLE_OVERFLOW.test(style.overflowY) && el.scrollHeight > el.clientHeight,
		x: SCROLLABLE_OVERFLOW.test(style.overflowX) && el.scrollWidth > el.clientWidth,
	}
}

// Brings a range into view without touching the DOM. `scrollIntoView` needs an element, and the nearest one to a
// match is often a whole paragraph or log line, which is the wrong thing to centre. Each scroll port is corrected
// in turn from the inside out, re-measuring as it goes because scrolling one shifts the range within the next.
export function scrollRangeIntoView(range: Range, margin = 56) {
	const start = range.startContainer.parentElement
	if (!start) return
	for (let el: Element | null = start; el; el = el.parentElement) {
		const axes = scrollableAxes(el)
		if (!axes.y && !axes.x) continue

		let rect = range.getBoundingClientRect()
		if (rect.width === 0 && rect.height === 0) rect = start.getBoundingClientRect()
		const port =
			el === document.documentElement
				? new DOMRect(0, 0, document.documentElement.clientWidth, document.documentElement.clientHeight)
				: el.getBoundingClientRect()

		if (axes.y) {
			const pad = Math.min(margin, port.height / 3)
			if (rect.top < port.top + pad) el.scrollTop += rect.top - (port.top + pad)
			else if (rect.bottom > port.bottom - pad) el.scrollTop += rect.bottom - (port.bottom - pad)
		}
		if (axes.x) {
			const pad = Math.min(margin, port.width / 3)
			if (rect.left < port.left + pad) el.scrollLeft += rect.left - (port.left + pad)
			else if (rect.right > port.right - pad) el.scrollLeft += rect.right - (port.right - pad)
		}
	}
}
