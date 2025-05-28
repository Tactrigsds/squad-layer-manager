export type OneToManyMap<K, V> = Map<K, Set<V>>
export function set<K, V>(map: OneToManyMap<K, V>, key: K, value: V) {
	let s = map.get(key)
	if (!s) {
		s = new Set()
		map.set(key, s)
	}
	s.add(value)
}

export function del<K, V>(map: OneToManyMap<K, V>, key: K, value: V) {
	const s = map.get(key)
	if (!s) return
	if (!s.has(value)) return
	s.delete(value)
	if (s.size === 0) map.delete(key)
}

export function has<K, V>(map: OneToManyMap<K, V>, key: K, value: V) {
	const s = map.get(key)
	if (!s) return false
	return s.has(value)
}

export function invert<K, V>(map: OneToManyMap<K, V>): OneToManyMap<V, K> {
	const newMap = new Map<V, Set<K>>()
	for (const [key, values] of map.entries()) {
		for (const value of values) {
			let s = newMap.get(value)
			if (!s) {
				s = new Set()
				newMap.set(value, s)
			}
			s.add(key)
		}
	}
	return newMap
}

export function invertOneToOne<K, V>(map: OneToManyMap<K, V>): Map<V, K> {
	const newMap = new Map<V, K>()
	for (const [key, values] of map.entries()) {
		for (const value of values) {
			newMap.set(value, key)
		}
	}
	return newMap
}

export function toJsonCompatible(map: OneToManyMap<string, string>): Record<string, string[]> {
	const json: Record<string, string[]> = {}
	for (const [key, values] of map.entries()) {
		json[key] = Array.from(values)
	}
	return json
}

export function fromJsonCompatible(json: Record<string, string[]>): OneToManyMap<string, string> {
	const map = new Map<string, Set<string>>()
	for (const [key, values] of Object.entries(json)) {
		map.set(key, new Set(values))
	}
	return map
}
