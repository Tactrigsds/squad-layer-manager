/**
 * Coalesces lookups by key into one fetch. Every key asked for before the next macrotask joins the same batch, and each
 * caller gets the value for its own key, or undefined when the fetch did not return one. Caching is the caller's: a key
 * asked for again later is fetched again.
 */
export function createBatchLoader<K, V>(fetchMany: (keys: K[]) => Promise<Map<K, V>>) {
	let open: { keys: Set<K>; values: Promise<Map<K, V>> } | null = null

	return function load(key: K): Promise<V | undefined> {
		if (!open) {
			const keys = new Set<K>()
			// a macrotask rather than a microtask: react starts the queries one render mounts across a single
			// passive-effect flush, and a microtask can run before that flush is done
			const values = new Promise<Map<K, V>>((resolve, reject) => {
				setTimeout(() => {
					open = null
					fetchMany([...keys]).then(resolve, reject)
				}, 0)
			})
			open = { keys, values }
		}
		open.keys.add(key)
		return open.values.then((values) => values.get(key))
	}
}
