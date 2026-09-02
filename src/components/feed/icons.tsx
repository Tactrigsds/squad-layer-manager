// static-render calls this component directly, so the react compiler must not inject its memo-cache hook
'use no memo'

// Lucide icons as inert jsx. Each shape is a fixed body string (see @/scripts/build-feed-icons), set as
// innerHTML rather than parsed into elements: the body is our own generated markup.

import React from 'react'

import { type IconName, SHAPES } from './icons.gen'

export type { IconName }

// lucide's own svg attributes; the shapes are drawn against them
const SVG_ATTRS = {
	xmlns: 'http://www.w3.org/2000/svg',
	width: 24,
	height: 24,
	viewBox: '0 0 24 24',
	fill: 'none',
	stroke: 'currentColor',
	strokeWidth: 2,
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
} as const

export function Icon(props: { name: IconName; className?: string }) {
	const [lucideClass, body] = SHAPES[props.name]
	return (
		<svg
			{...SVG_ATTRS}
			className={props.className ? `${lucideClass} ${props.className}` : lucideClass}
			dangerouslySetInnerHTML={{ __html: body }}
		/>
	)
}
