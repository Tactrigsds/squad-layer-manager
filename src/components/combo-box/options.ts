import type { ComboBoxOption } from './combo-box.tsx'
import { LOADING } from './constants.ts'

// normalizes raw options to ComboBoxOption[], asserts value uniqueness, and sorts (disabled last,
// then label/value unless sort is false). memoize at the call site -- this runs O(n log n) over
// option lists that can be thousands of entries long
export function normalizeOptions<T extends string | null>(
	componentName: string,
	rawOptions: (ComboBoxOption<T> | T)[] | typeof LOADING,
	sort: boolean = true,
): ComboBoxOption<T>[] | typeof LOADING {
	if (rawOptions === LOADING) return LOADING

	const options = rawOptions.map((item): ComboBoxOption<T> =>
		typeof item === 'string' || item === null ? { value: item as T } : item
	)

	const seen = new Set<T>()
	const duplicates: T[] = []
	for (const option of options) {
		if (seen.has(option.value)) duplicates.push(option.value)
		seen.add(option.value)
	}
	if (duplicates.length > 0) {
		throw new Error(`${componentName} options contain duplicate values: ${duplicates.join(', ')}`)
	}

	options.sort((a, b) => {
		const disabledDiff = (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0)
		if (disabledDiff !== 0) return disabledDiff
		if (!sort) return 0
		const aKey = typeof a.label === 'string' ? a.label : (a.value ?? '')
		const bKey = typeof b.label === 'string' ? b.label : (b.value ?? '')
		return aKey.localeCompare(bKey)
	})

	return options
}
