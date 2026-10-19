import type * as LC from '@/models/layer-columns.models'

// Values derived from one layer data, cached on its components object and built on first use. A components object is
// never changed once built, so nothing cached here goes stale, and loading other layer data leaves the old values to
// be collected with the old components. A derivation that throws (layer data not loaded yet) caches nothing.
//
// This module imports nothing at runtime, so layer.models and layer-columns.models, which import each other, can both
// define their caches at module level.

const valuesByComponents = new WeakMap<LC.LayerComponents, Map<object, unknown>>()

/** A value computed from the layer data once. */
export function derived<T>(derive: (components: LC.LayerComponents) => T): (components: LC.LayerComponents) => T {
	return (components) => {
		let values = valuesByComponents.get(components)
		if (!values) valuesByComponents.set(components, (values = new Map()))
		if (values.has(derive)) return values.get(derive) as T
		const value = derive(components)
		values.set(derive, value)
		return value
	}
}

/**
 * A lookup into the layer data, keeping at most `maxEntries` results. Keys can come from anywhere (links, RCON, stored
 * rows), so a full cache is dropped rather than left to grow.
 */
export function lookup<K, V>(
	compute: (key: K, components: LC.LayerComponents) => V,
	maxEntries: number,
): (key: K, components: LC.LayerComponents) => V {
	const resultsOf = derived(() => new Map<K, V>())
	return (key, components) => {
		const results = resultsOf(components)
		if (results.has(key)) return results.get(key)!
		const result = compute(key, components)
		if (results.size >= maxEntries) results.clear()
		results.set(key, result)
		return result
	}
}
