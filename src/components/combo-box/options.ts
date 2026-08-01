import * as DH from '@/lib/display-helpers.ts'

import type { ComboBoxOption } from './combo-box.tsx'
import { LOADING } from './constants.ts'

// the string cmdk identifies an option's item by, which is what it reports as the highlighted item.
// It's the item's `value` prop trimmed, falling back to the rendered text content when that's unset
// (null-valued options). A label that isn't a plain string has no key we can predict here.
export function cmdkItemKey<T extends string | null>(option: ComboBoxOption<T>): string | null {
	if (option.value !== null) return option.value.trim()
	if (option.label == null) return DH.NULL_DISPLAY.trim()
	return typeof option.label === 'string' ? option.label.trim() : null
}

// normalizes raw options to ComboBoxOption[], asserts value uniqueness, and sorts (disabled and
// sortLast options last, then group, then label/value unless sort is false). memoize at the call
// site -- this runs O(n log n) over option lists that can be thousands of entries long
export function normalizeOptions<T extends string | null>(
	componentName: string,
	rawOptions: (ComboBoxOption<T> | T)[] | typeof LOADING,
	sort: boolean = true,
	groupOrder?: readonly string[],
): ComboBoxOption<T>[] | typeof LOADING {
	if (rawOptions === LOADING) return LOADING

	const options = rawOptions.map((item): ComboBoxOption<T> => (typeof item === 'string' || item === null ? { value: item as T } : item))

	const seen = new Set<T>()
	const duplicates: T[] = []
	for (const option of options) {
		if (seen.has(option.value)) duplicates.push(option.value)
		seen.add(option.value)
	}
	if (duplicates.length > 0) {
		throw new Error(`${componentName} options contain duplicate values: ${duplicates.join(', ')}`)
	}

	// unlisted groups trail listed ones alphabetically, and ungrouped options trail everything: in a list
	// that groups at all, a value we could not place is the least likely one to be wanted
	const groupRank = (option: ComboBoxOption<T>) => {
		if (option.group == null) return (groupOrder?.length ?? 0) + 1
		if (!groupOrder) return 0
		const index = groupOrder.indexOf(option.group)
		return index === -1 ? groupOrder.length : index
	}
	options.sort((a, b) => {
		const disabledDiff = (a.disabled || a.sortLast ? 1 : 0) - (b.disabled || b.sortLast ? 1 : 0)
		if (disabledDiff !== 0) return disabledDiff
		const groupDiff = groupRank(a) - groupRank(b) || (a.group ?? '').localeCompare(b.group ?? '')
		if (groupDiff !== 0) return groupDiff
		if (!sort) return 0
		const aKey = typeof a.label === 'string' ? a.label : (a.value ?? '')
		const bKey = typeof b.label === 'string' ? b.label : (b.value ?? '')
		return aKey.localeCompare(bKey)
	})

	return options
}

// consecutive same-group runs of normalized options, for rendering as headed sections. Excluded
// (disabled/sortLast) options count as ungrouped, so the excluded tail renders heading-less. When the
// live options span fewer than two groups, headings are noise: everything comes back as one run.
export function groupRuns<T extends string | null>(options: ComboBoxOption<T>[]): { heading?: string; options: ComboBoxOption<T>[] }[] {
	const headingOf = (option: ComboBoxOption<T>) => (option.disabled || option.sortLast ? undefined : option.group)
	const headings = new Set(options.map(headingOf))
	headings.delete(undefined)
	if (headings.size < 2) return [{ options }]
	const runs: { heading?: string; options: ComboBoxOption<T>[] }[] = []
	for (const option of options) {
		const heading = headingOf(option)
		const last = runs[runs.length - 1]
		if (last && last.heading === heading) last.options.push(option)
		else runs.push({ heading, options: [option] })
	}
	return runs
}
