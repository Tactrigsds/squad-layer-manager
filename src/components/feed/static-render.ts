// Renders an inert template's element tree straight to dom, on the client.
//
// The templates carry no hooks, refs, context or state, so "rendering" one is: call every function
// component, create every host element, recurse. react-dom's own server renderer does the same job for the
// html-string side, but its dev build pays per-component instrumentation that turns a 600-row feed into
// seconds, and its client renderer buys nothing a static row needs. This walker covers exactly the props the
// templates use and throws on anything else, so a template that grows past it fails loudly.

import { Fragment, type ReactElement, type ReactNode } from 'react'

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'line', 'rect', 'polygon', 'polyline', 'g', 'defs', 'use'])

// react prop names whose attribute differs; everything else passes through verbatim (data-*, aria-*, title,
// viewBox and friends are already attribute-cased in the templates)
const ATTR_ALIASES: Record<string, string> = {
	className: 'class',
	strokeWidth: 'stroke-width',
	strokeLinecap: 'stroke-linecap',
	strokeLinejoin: 'stroke-linejoin',
	htmlFor: 'for',
}

// css property names are camelCase in a style object; custom properties pass through
function cssName(prop: string): string {
	if (prop.startsWith('--')) return prop
	return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function applyStyle(el: Element, style: Record<string, unknown>) {
	let out = ''
	for (const prop in style) {
		const value = style[prop]
		if (value === null || value === undefined) continue
		// only string values: react's px-suffixing of numeric lengths is deliberately not replicated
		if (typeof value !== 'string') throw new Error(`static render: non-string style value for ${prop}`)
		out += `${cssName(prop)}:${value};`
	}
	if (out) el.setAttribute('style', out)
}

function renderInto(parent: Node, node: ReactNode, svg: boolean) {
	if (node === null || node === undefined || node === false || node === true || node === '') return
	if (typeof node === 'string' || typeof node === 'number') {
		parent.appendChild(document.createTextNode(String(node)))
		return
	}
	if (Array.isArray(node)) {
		for (const child of node) renderInto(parent, child, svg)
		return
	}
	if (typeof node === 'object' && 'type' in node) {
		const element = node as ReactElement<Record<string, unknown>>
		const type = element.type
		if (type === Fragment) {
			renderInto(parent, element.props.children as ReactNode, svg)
			return
		}
		if (typeof type === 'function') {
			renderInto(parent, (type as (props: unknown) => ReactNode)(element.props), svg)
			return
		}
		if (typeof type !== 'string') throw new Error('static render: unsupported element type')
		const inSvg = svg || SVG_TAGS.has(type)
		const el = inSvg ? document.createElementNS(SVG_NS, type) : document.createElement(type)
		for (const prop in element.props) {
			const value = element.props[prop]
			if (value === null || value === undefined || value === false) continue
			if (prop === 'children') continue
			if (prop === 'style') {
				applyStyle(el, value as Record<string, unknown>)
				continue
			}
			if (prop === 'dangerouslySetInnerHTML') {
				el.innerHTML = (value as { __html: string }).__html
				continue
			}
			if (typeof value === 'string' || typeof value === 'number') {
				el.setAttribute(ATTR_ALIASES[prop] ?? prop, String(value))
				continue
			}
			if (value === true) {
				el.setAttribute(ATTR_ALIASES[prop] ?? prop, '')
				continue
			}
			throw new Error(`static render: unsupported prop ${prop}`)
		}
		if (!('dangerouslySetInnerHTML' in element.props)) renderInto(el, element.props.children as ReactNode, inSvg)
		parent.appendChild(el)
		return
	}
	throw new Error('static render: unsupported node')
}

/** The template's dom, or null when it renders nothing. */
export function renderStatic(node: ReactNode): Node | null {
	const fragment = document.createDocumentFragment()
	renderInto(fragment, node, false)
	if (fragment.childNodes.length === 0) return null
	if (fragment.childNodes.length === 1) return fragment.firstChild
	return fragment
}
