export function deepClone<K, T>(map: Map<K, T>): Map<K, T> {
	const newMap = new Map<K, T>()
	for (const [key, value] of map.entries()) {
		newMap.set(key, value)
	}
	return newMap
}

export function filter<K, T>(map: Map<K, T>, predicate: (key: K, value: T) => boolean): Map<K, T> {
	const newMap = new Map<K, T>()
	for (const [key, value] of map.entries()) {
		if (predicate(key, value)) {
			newMap.set(key, value)
		}
	}
	return newMap
}

export function mapToArray<K, T>(map: Map<K, T>, fn: (key: K, value: T) => [K, T]): [K, T][] {
	const arr: [K, T][] = []
	for (const [key, value] of map.entries()) {
		arr.push(fn(key, value))
	}
	return arr
}
