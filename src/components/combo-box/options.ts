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

// the option's heading in the description box, which writes text rather than rendering nodes. An option
// whose label is a node has no text form beyond its value, and a null-valued one has none at all.
export function descriptionTitle<T extends string | null>(option: ComboBoxOption<T>): string | null {
	if (option.chipLabel) return option.chipLabel
	if (typeof option.label === 'string') return option.label
	return option.value
}

// the options carrying a description, keyed the way cmdk reports its highlighted item
export function descriptionsByItemKey<T extends string | null>(options: ComboBoxOption<T>[]): Map<string, ComboBoxOption<T>> {
	const map = new Map<string, ComboBoxOption<T>>()
	for (const option of options) {
		if (option.description == null) continue
		const key = cmdkItemKey(option)
		if (key !== null) map.set(key, option)
	}
	return map
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

// -------- groups --------

// A group an option can belong to. Given as a bare key when the key is already the display text.
export type ComboBoxGroupDef = {
	key: string
	// tab label; defaults to the key
	label?: string
	// compact form used when prefixing an option's label; defaults to the label. null prefixes nothing, for
	// the group whose membership is the unremarkable default and so goes unsaid
	prefix?: string | null
}

export type ResolvedGroup = { key: string; label: string; prefix: string | null }

// replaces the default group badge shown ahead of a prefixed option label
export type GroupPrefixRenderer = (prefix: string) => React.ReactNode

// the pseudo-group whose tab shows every group at once
export const ALL_GROUPS = '__all_groups__'

export function resolveGroups(groups?: readonly (ComboBoxGroupDef | string)[]): ResolvedGroup[] {
	if (!groups) return []
	return groups.map((group) => {
		const def = typeof group === 'string' ? { key: group } : group
		const label = def.label ?? def.key
		return { key: def.key, label, prefix: def.prefix === undefined ? label : def.prefix }
	})
}

// the groups with options a user can actually pick, in declared order. Groups the caller did not declare
// trail alphabetically, so an undeclared group is still reachable rather than silently unlisted.
export function liveGroups<T extends string | null>(options: ComboBoxOption<T>[], groups: readonly ResolvedGroup[]): ResolvedGroup[] {
	const present = new Set<string>()
	for (const option of options) {
		if (option.disabled || option.sortLast || option.group == null) continue
		present.add(option.group)
	}
	const declared = groups.filter((group) => present.has(group.key))
	const undeclared = [...present]
		.filter((key) => !groups.some((group) => group.key === key))
		.sort()
		.map((key): ResolvedGroup => ({ key, label: key, prefix: key }))
	return [...declared, ...undeclared]
}

export function optionsInGroup<T extends string | null>(options: ComboBoxOption<T>[], group: string): ComboBoxOption<T>[] {
	if (group === ALL_GROUPS) return options
	return options.filter((option) => option.group === group)
}

export function groupPrefixOf<T extends string | null>(option: ComboBoxOption<T>, groups: readonly ResolvedGroup[]): string | undefined {
	if (option.group == null) return undefined
	const group = groups.find((group) => group.key === option.group)
	if (!group) return option.group
	return group.prefix ?? undefined
}

// consecutive same-group runs of normalized options, for rendering as headed sections. Excluded
// (disabled/sortLast) options count as ungrouped, so the excluded tail renders heading-less. When the
// live options span fewer than two groups, headings are noise: everything comes back as one run.
export function groupRuns<T extends string | null>(
	options: ComboBoxOption<T>[],
	suppressHeadings = false,
): { heading?: string; options: ComboBoxOption<T>[] }[] {
	if (suppressHeadings) return [{ options }]
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
