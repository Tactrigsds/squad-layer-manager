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
