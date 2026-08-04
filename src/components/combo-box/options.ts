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

// the option's heading in the description box, which writes text rather than rendering nodes. It reads as
// the row does, so the label leads; an option whose label is a node falls back to a text form of it, and a
// null-valued one has none at all.
export function descriptionTitle<T extends string | null>(option: ComboBoxOption<T>): string | null {
	if (typeof option.label === 'string') return option.label
	return option.chipLabel ?? option.value
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

// -------- groupings --------

// A grouping is one dimension the list can be narrowed by: collection, vehicle class, and so on. Several
// can be active at once and they intersect, so an option shows only while it matches every narrowed one.
// An option belongs to at most one group per grouping.
//
// The first grouping is the primary one: it alone orders the list, prefixes option labels and heads
// sections. The rest narrow without marking their rows, because a row carrying every grouping it belongs
// to reads as a wall of badges.

// A group an option can belong to. Given as a bare key when the key is already the display text.
export type ComboBoxGroupDef = {
	key: string
	// tab label; defaults to the key
	label?: string
	// compact form used when prefixing an option's label; defaults to the label. null prefixes nothing, for
	// the group whose membership is the unremarkable default and so goes unsaid
	prefix?: string | null
}

export type GroupingControl = 'tabs' | 'facet'

export type ComboBoxGroupingDef = {
	key: string
	// names the dimension where its groups do not: the facet button, the drill-in header
	label: string
	groups: readonly (ComboBoxGroupDef | string)[]
	// tabs while the groups fit, a drill-in facet past that. Set to pin one either way.
	control?: GroupingControl
}

export type ResolvedGroup = { key: string; label: string; prefix: string | null }
export type ResolvedGrouping = { key: string; label: string; groups: ResolvedGroup[]; control?: GroupingControl }

// which group is picked per grouping. A grouping absent from the map, or set to ALL_GROUPS, is not narrowing.
export type GroupSelection = Readonly<Record<string, string>>

// replaces the default group badge shown ahead of a prefixed option label
export type GroupPrefixRenderer = (prefix: string) => React.ReactNode

// the pseudo-group whose tab shows every group at once
export const ALL_GROUPS = '__all_groups__'

// past this many live groups a tab strip stops being readable and the grouping drills in instead. Six fits
// the collection catalog with room to spare, and is well short of the vehicle classes.
export const MAX_TAB_GROUPS = 6

export function resolveGroups(groups: readonly (ComboBoxGroupDef | string)[]): ResolvedGroup[] {
	return groups.map((group) => {
		const def = typeof group === 'string' ? { key: group } : group
		const label = def.label ?? def.key
		return { key: def.key, label, prefix: def.prefix === undefined ? label : def.prefix }
	})
}

export function resolveGroupings(groupings?: readonly ComboBoxGroupingDef[]): ResolvedGrouping[] {
	if (!groupings) return []
	return groupings.map((grouping) => ({
		key: grouping.key,
		label: grouping.label,
		groups: resolveGroups(grouping.groups),
		control: grouping.control,
	}))
}

export function groupOf<T extends string | null>(option: ComboBoxOption<T>, grouping: string): string | undefined {
	return option.groups?.[grouping]
}

// options that sort to the back wherever they belong, so counting them would advertise groups that lead
// only to dead rows
function excluded<T extends string | null>(option: ComboBoxOption<T>): boolean {
	return !!option.disabled || !!option.sortLast
}

// normalizes raw options to ComboBoxOption[], asserts value uniqueness, and sorts (disabled and
// sortLast options last, then the primary grouping, then label/value unless sort is false). memoize at the
// call site -- this runs O(n log n) over option lists that can be thousands of entries long
export function normalizeOptions<T extends string | null>(
	componentName: string,
	rawOptions: (ComboBoxOption<T> | T)[] | typeof LOADING,
	sort: boolean = true,
	primary?: { key: string; order?: readonly string[] },
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

	const groupKey = (option: ComboBoxOption<T>) => (primary ? groupOf(option, primary.key) : undefined)
	// unlisted groups trail listed ones alphabetically, and ungrouped options trail everything: in a list
	// that groups at all, a value we could not place is the least likely one to be wanted
	const groupRank = (option: ComboBoxOption<T>) => {
		const group = groupKey(option)
		const order = primary?.order
		if (group == null) return (order?.length ?? 0) + 1
		if (!order) return 0
		const index = order.indexOf(group)
		return index === -1 ? order.length : index
	}
	options.sort((a, b) => {
		const disabledDiff = (excluded(a) ? 1 : 0) - (excluded(b) ? 1 : 0)
		if (disabledDiff !== 0) return disabledDiff
		const groupDiff = groupRank(a) - groupRank(b) || (groupKey(a) ?? '').localeCompare(groupKey(b) ?? '')
		if (groupDiff !== 0) return groupDiff
		if (!sort) return 0
		const aKey = typeof a.label === 'string' ? a.label : (a.value ?? '')
		const bKey = typeof b.label === 'string' ? b.label : (b.value ?? '')
		return aKey.localeCompare(bKey)
	})

	return options
}

// the groups of one grouping with options a user can actually pick, in declared order. Groups the caller
// did not declare trail alphabetically, so an undeclared group is still reachable rather than silently
// unlisted.
export function liveGroups<T extends string | null>(options: ComboBoxOption<T>[], grouping: ResolvedGrouping): ResolvedGroup[] {
	const present = new Set<string>()
	for (const option of options) {
		const group = groupOf(option, grouping.key)
		if (excluded(option) || group == null) continue
		present.add(group)
	}
	const declared = grouping.groups.filter((group) => present.has(group.key))
	const undeclared = [...present]
		.filter((key) => !grouping.groups.some((group) => group.key === key))
		.sort()
		.map((key): ResolvedGroup => ({ key, label: key, prefix: key }))
	return [...declared, ...undeclared]
}

// the control a grouping renders as, given how many of its groups are live
export function controlFor(grouping: ResolvedGrouping, liveCount: number): GroupingControl {
	return grouping.control ?? (liveCount > MAX_TAB_GROUPS ? 'facet' : 'tabs')
}

export type GroupingBarEntry = { grouping: ResolvedGrouping; live: ResolvedGroup[]; control: GroupingControl; narrowed: string }

// every grouping worth showing a control for, resolved against the options actually present. A grouping
// whose options all land in one group narrows nothing, so it stays out of the bar rather than offering a
// choice between "all" and the same thing.
export function groupingBarEntries<T extends string | null>(
	options: ComboBoxOption<T>[],
	groupings: readonly ResolvedGrouping[],
	selection: GroupSelection,
): GroupingBarEntry[] {
	const entries: GroupingBarEntry[] = []
	for (const grouping of groupings) {
		const live = liveGroups(options, grouping)
		if (live.length < 2) continue
		entries.push({ grouping, live, control: controlFor(grouping, live.length), narrowed: narrowedGroup(selection, grouping, live) })
	}
	return entries
}

// a grouping narrows only while its pick names a live group, so a stale or defaulted pick degrades to
// "all" instead of showing an empty list
export function narrowedGroup(selection: GroupSelection, grouping: ResolvedGrouping, live: readonly ResolvedGroup[]): string {
	const picked = selection[grouping.key] ?? ALL_GROUPS
	return live.some((group) => group.key === picked) ? picked : ALL_GROUPS
}

// options matching every narrowed grouping. `except` leaves one grouping out, which is what lets a
// drill-in list count the options a pick would actually reach rather than the whole catalog.
export function optionsInSelection<T extends string | null>(
	options: ComboBoxOption<T>[],
	selection: GroupSelection,
	except?: string,
): ComboBoxOption<T>[] {
	const active = Object.entries(selection).filter(([key, group]) => key !== except && group !== ALL_GROUPS)
	if (active.length === 0) return options
	return options.filter((option) => active.every(([key, group]) => groupOf(option, key) === group))
}

// how many options a selection leaves, counted the same way the per-group counts are so the "all" row and
// the group rows of a drill-in agree
export function selectableCount<T extends string | null>(options: ComboBoxOption<T>[], selection: GroupSelection, except?: string): number {
	return optionsInSelection(options, selection, except).filter((option) => !excluded(option)).length
}

// how many options each group of a grouping would leave, with the other groupings' picks already applied
export function groupCounts<T extends string | null>(
	options: ComboBoxOption<T>[],
	grouping: ResolvedGrouping,
	selection: GroupSelection,
): Map<string, number> {
	const counts = new Map<string, number>()
	for (const option of optionsInSelection(options, selection, grouping.key)) {
		if (excluded(option)) continue
		const group = groupOf(option, grouping.key)
		if (group == null) continue
		counts.set(group, (counts.get(group) ?? 0) + 1)
	}
	return counts
}

export function groupPrefixOf<T extends string | null>(
	option: ComboBoxOption<T>,
	grouping: ResolvedGrouping | undefined,
): string | undefined {
	if (!grouping) return undefined
	const key = groupOf(option, grouping.key)
	if (key == null) return undefined
	const group = grouping.groups.find((group) => group.key === key)
	if (!group) return key
	return group.prefix ?? undefined
}

// consecutive same-group runs of normalized options, for rendering as headed sections. Excluded
// (disabled/sortLast) options count as ungrouped, so the excluded tail renders heading-less. When the
// live options span fewer than two groups, headings are noise: everything comes back as one run.
export function groupRuns<T extends string | null>(
	options: ComboBoxOption<T>[],
	grouping: ResolvedGrouping | undefined,
	suppressHeadings = false,
): { heading?: string; options: ComboBoxOption<T>[] }[] {
	if (suppressHeadings || !grouping) return [{ options }]
	const headingOf = (option: ComboBoxOption<T>) => (excluded(option) ? undefined : groupOf(option, grouping.key))
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
