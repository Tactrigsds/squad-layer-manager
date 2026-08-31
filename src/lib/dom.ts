// Building real dom nodes, for the surfaces where react's per-node cost is the thing being paid for. The activity
// feed is the one that matters: a past match is ~600 rows and ~10,000 nodes arriving at once, which react renders
// in a single uninterruptible block.
//
// Attribute names are html's, not react's -- `class`, `stroke-width`, `xlink:href`. Nothing here diffs or keys;
// a caller that needs to update rebuilds the node.
//
// The same builders run on the server, where there is no document: the factory swaps in a minimal shadow node
// covering exactly the surface the builders use (setAttribute, appendChild, cloneNode, innerHTML assignment), and
// `serialize` turns either kind into html. This is what lets the server render result rows to strings.

export type Child = Node | string | number | false | null | undefined | Child[]

export type Attrs = Record<string, string | number | boolean | null | undefined>

const SVG_NS = 'http://www.w3.org/2000/svg'

const BROWSER = typeof document !== 'undefined'

// -------- the server-side shadow dom --------

class ShadowText {
	constructor(public data: string) {}
}

class ShadowFragment {
	childNodes: (ShadowElement | ShadowText | ShadowFragment)[] = []
	appendChild<T extends ShadowElement | ShadowText | ShadowFragment>(child: T): T {
		this.childNodes.push(child)
		return child
	}
}

class ShadowElement {
	childNodes: (ShadowElement | ShadowText | ShadowFragment)[] = []
	attrs = new Map<string, string>()
	// set via `innerHTML =`; only ever our own generated markup (the icon shapes), serialized verbatim
	rawHtml: string | null = null

	constructor(public tagName: string) {}

	setAttribute(name: string, value: string) {
		this.attrs.set(name, value)
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null
	}

	appendChild<T extends ShadowElement | ShadowText | ShadowFragment>(child: T): T {
		this.childNodes.push(child)
		return child
	}

	set innerHTML(html: string) {
		this.rawHtml = html
		this.childNodes = []
	}

	cloneNode(deep?: boolean): ShadowElement {
		const copy = new ShadowElement(this.tagName)
		copy.attrs = new Map(this.attrs)
		copy.rawHtml = this.rawHtml
		if (deep) {
			copy.childNodes = this.childNodes.map((child) => {
				if (child instanceof ShadowText) return new ShadowText(child.data)
				if (child instanceof ShadowElement) return child.cloneNode(true)
				const fragment = new ShadowFragment()
				fragment.childNodes = child.childNodes.map((inner) =>
					inner instanceof ShadowText ? new ShadowText(inner.data) : inner instanceof ShadowElement ? inner.cloneNode(true) : inner,
				)
				return fragment
			})
		}
		return copy
	}
}

export function isNode(value: unknown): value is Node {
	if (value instanceof ShadowElement || value instanceof ShadowText || value instanceof ShadowFragment) return true
	return BROWSER && value instanceof Node
}

function escapeText(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttr(text: string): string {
	return escapeText(text).replaceAll('"', '&quot;')
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'link', 'meta'])

function serializeShadow(node: ShadowElement | ShadowText | ShadowFragment): string {
	if (node instanceof ShadowText) return escapeText(node.data)
	if (node instanceof ShadowFragment) return node.childNodes.map(serializeShadow).join('')
	let out = `<${node.tagName}`
	for (const [name, value] of node.attrs) out += ` ${name}="${escapeAttr(value)}"`
	if (VOID_TAGS.has(node.tagName)) return `${out}/>`
	out += '>'
	if (node.rawHtml !== null) out += node.rawHtml
	else out += node.childNodes.map(serializeShadow).join('')
	return `${out}</${node.tagName}>`
}

/** The node as html, on either side. */
export function serialize(node: Node): string {
	if (node instanceof ShadowElement || node instanceof ShadowText || node instanceof ShadowFragment) return serializeShadow(node)
	if (node instanceof Element) return node.outerHTML
	if (node instanceof Text) return escapeText(node.data)
	const div = document.createElement('div')
	div.appendChild(node.cloneNode(true))
	return div.innerHTML
}

// -------- the builders --------

export function append(parent: Node, child: Child): void {
	if (child === null || child === undefined || child === false || child === '') return
	if (Array.isArray(child)) {
		for (const part of child) append(parent, part)
		return
	}
	if (typeof child === 'object') {
		parent.appendChild(child)
		return
	}
	const text = String(child)
	parent.appendChild(BROWSER ? document.createTextNode(text) : (new ShadowText(text) as unknown as Node))
}

function applyAttrs(node: Element, attrs: Attrs | null | undefined) {
	if (!attrs) return
	for (const name in attrs) {
		const value = attrs[name]
		if (value === null || value === undefined || value === false) continue
		node.setAttribute(name, value === true ? '' : String(value))
	}
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
	const node = (BROWSER ? document.createElement(tag) : new ShadowElement(tag)) as HTMLElementTagNameMap[K]
	applyAttrs(node, attrs)
	for (const child of children) append(node, child)
	return node
}

export function svg(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
	const node = (BROWSER ? document.createElementNS(SVG_NS, tag) : new ShadowElement(tag)) as SVGElement
	applyAttrs(node, attrs)
	for (const child of children) append(node, child)
	return node
}

export function frag(...children: Child[]): DocumentFragment {
	const fragment = (BROWSER ? document.createDocumentFragment() : new ShadowFragment()) as DocumentFragment
	for (const child of children) append(fragment, child)
	return fragment
}

/** `cn` for a builder: joins the truthy parts, or returns undefined so the attribute is skipped entirely. */
export function cls(...parts: (string | false | null | undefined)[]): string | undefined {
	let out = ''
	for (const part of parts) {
		if (!part) continue
		out = out ? `${out} ${part}` : part
	}
	return out || undefined
}

/** Inline styles as a builder writes them: an object, rendered to the `style` attribute's own syntax. */
export function style(decls: Record<string, string | number | null | undefined>): string | undefined {
	let out = ''
	for (const prop in decls) {
		const value = decls[prop]
		if (value === null || value === undefined) continue
		out += `${prop}:${value};`
	}
	return out || undefined
}
