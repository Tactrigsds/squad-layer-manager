// Building real dom nodes, for the surfaces where react's per-node cost is the thing being paid for. The activity
// feed is the one that matters: a past match is ~600 rows and ~10,000 nodes arriving at once, which react renders
// in a single uninterruptible block.
//
// Attribute names are html's, not react's -- `class`, `stroke-width`, `xlink:href`. Nothing here diffs or keys;
// a caller that needs to update rebuilds the node.

export type Child = Node | string | number | false | null | undefined | Child[]

export type Attrs = Record<string, string | number | boolean | null | undefined>

const SVG_NS = 'http://www.w3.org/2000/svg'

export function append(parent: Node, child: Child): void {
	if (child === null || child === undefined || child === false || child === '') return
	if (Array.isArray(child)) {
		for (const part of child) append(parent, part)
		return
	}
	parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
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
	const node = document.createElement(tag)
	applyAttrs(node, attrs)
	for (const child of children) append(node, child)
	return node
}

export function svg(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
	const node = document.createElementNS(SVG_NS, tag)
	applyAttrs(node, attrs)
	for (const child of children) append(node, child)
	return node
}

export function frag(...children: Child[]): DocumentFragment {
	const fragment = document.createDocumentFragment()
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
