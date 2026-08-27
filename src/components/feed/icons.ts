// Lucide icons as dom nodes. A feed row is a fifth svg by node count, and every one of them is one of a couple of
// dozen fixed shapes at a couple of dozen fixed sizes, so each distinct (shape, class) pair is built once and
// cloned after that.

import * as Dom from '@/lib/dom'

import { type IconName, SHAPES } from './icons.gen'

export type { IconName }

// lucide's own svg attributes; the shapes are drawn against them (see @/scripts/build-feed-icons)
const SVG_ATTRS = {
	xmlns: 'http://www.w3.org/2000/svg',
	width: 24,
	height: 24,
	viewBox: '0 0 24 24',
	fill: 'none',
	stroke: 'currentColor',
	'stroke-width': 2,
	'stroke-linecap': 'round',
	'stroke-linejoin': 'round',
}

const templates = new Map<string, SVGElement>()

export function icon(name: IconName, className?: string): SVGElement {
	const key = className ? `${name} ${className}` : name
	let template = templates.get(key)
	if (!template) {
		const [lucideClass, body] = SHAPES[name]
		template = Dom.svg('svg', { ...SVG_ATTRS, class: className ? `${lucideClass} ${className}` : lucideClass })
		template.innerHTML = body
		templates.set(key, template)
	}
	return template.cloneNode(true) as SVGElement
}
