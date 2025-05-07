export function deepClone<K, T>(map: Map<K, T>): Map<K, T> {
	const newMap = new Map<K, T>()
	for (const [key, value] of map.entries()) {
		newMap.set(key, value)
	}
	return newMap
}
