// the react compiler would cache renders against tanstack's virtualizer, a mutable instance whose identity never changes
'use no memo'

// Mounts only the option rows in view, for lists of VIRTUALIZE_MIN_OPTIONS or more.
//
// Rows stay in normal flow between spacers rather than being positioned absolutely, so the mounted rows still size
// the popover's width and cmdk's scrollIntoView lands on them where they render.
//
// cmdk sees only the mounted items, so three rows stay mounted regardless of scroll position:
// - the first and last options, which Home and End select
// - the highlighted option. cmdk selects the first item whenever the highlighted one unmounts, then scrolls to it,
//   so scrolling the highlight out of view would otherwise throw the list back to the top.

import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual'
import { useCommandState } from 'cmdk'
import React from 'react'

import type { ComboBoxOption } from './combo-box.tsx'
import type { OptionRow } from './options.ts'

const ESTIMATED_OPTION_PX = 32
const ESTIMATED_HEADING_PX = 24
const OVERSCAN = 8

export function VirtualOptionRows<T extends string | null>(props: {
	rows: readonly OptionRow<T>[]
	// the value cmdk registers the option's item under; null where it cannot be predicted
	itemValue: (option: ComboBoxOption<T>) => string | null
	rowKey: (option: ComboBoxOption<T>) => string
	renderOption: (option: ComboBoxOption<T>) => React.ReactNode
}) {
	const { rows, itemValue } = props
	const containerRef = React.useRef<HTMLDivElement | null>(null)

	const indexByValue = React.useMemo(() => {
		const map = new Map<string, number>()
		for (const [i, row] of rows.entries()) {
			if (row.kind !== 'option') continue
			const value = itemValue(row.option)
			if (value !== null) map.set(value, i)
		}
		return map
	}, [rows, itemValue])
	const edges = React.useMemo(() => {
		const first = rows.findIndex((row) => row.kind === 'option')
		return first === -1 ? [] : [first, rows.length - 1]
	}, [rows])

	const highlighted = useCommandState((state) => state.value)
	const highlightedIndex = indexByValue.get(highlighted)
	const rangeExtractor = React.useCallback(
		(range: Range) => {
			const indexes = new Set(defaultRangeExtractor(range))
			for (const i of edges) indexes.add(i)
			if (highlightedIndex !== undefined) indexes.add(highlightedIndex)
			return [...indexes].sort((a, b) => a - b)
		},
		[edges, highlightedIndex],
	)

	// row heights follow the theme's density, so the estimates come from the first row of each kind to mount. A wrong
	// estimate misplaces every unmounted row, and cmdk's scrollIntoView then misses its target.
	const estimatesRef = React.useRef({ option: ESTIMATED_OPTION_PX, heading: ESTIMATED_HEADING_PX })
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => containerRef.current?.closest<HTMLElement>('[cmdk-list]') ?? null,
		estimateSize: (i) => (rows[i].kind === 'heading' ? estimatesRef.current.heading : estimatesRef.current.option),
		getItemKey: (i) => {
			const row = rows[i]
			return row.kind === 'heading' ? `heading:${row.key}` : `option:${props.rowKey(row.option)}`
		},
		overscan: OVERSCAN,
		rangeExtractor,
		initialRect: { width: 0, height: ESTIMATED_OPTION_PX * 12 },
	})

	React.useLayoutEffect(() => {
		const container = containerRef.current
		if (!container) return
		const estimates = estimatesRef.current
		const option = container.querySelector<HTMLElement>('[cmdk-item]')?.offsetHeight
		const heading = container.querySelector<HTMLElement>('[cmdk-group-heading]')?.offsetHeight
		let changed = false
		if (option && option !== estimates.option) {
			estimates.option = option
			changed = true
		}
		if (heading && heading !== estimates.heading) {
			estimates.heading = heading
			changed = true
		}
		if (changed) virtualizer.measure()
	})

	const children: React.ReactNode[] = []
	let end = 0
	for (const item of virtualizer.getVirtualItems()) {
		if (item.start > end) children.push(<div key={`gap-${children.length}`} aria-hidden style={{ height: item.start - end }} />)
		const row = rows[item.index]
		children.push(
			<div key={item.key} data-index={item.index} ref={virtualizer.measureElement}>
				{row.kind === 'heading' ? (
					<div cmdk-group-heading="" aria-hidden className="fd-mlabel">
						{row.label}
					</div>
				) : (
					props.renderOption(row.option)
				)}
			</div>,
		)
		end = item.end
	}
	const total = virtualizer.getTotalSize()
	if (total > end) children.push(<div key="gap-end" aria-hidden style={{ height: total - end }} />)

	return <div ref={containerRef}>{children}</div>
}
