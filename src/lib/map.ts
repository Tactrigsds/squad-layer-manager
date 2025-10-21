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

export function map<K, T, U>(map: Map<K, T>, fn: (key: K, value: T) => U): Map<K, U> {
	const newMap = new Map<K, U>()
	for (const [key, value] of map.entries()) {
		newMap.set(key, fn(key, value))
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

export function union<K, T>(...maps: Map<K, T>[]): Map<K, T> {
	const newMap = new Map<K, T>()
	for (const map of maps) {
		for (const [key, value] of map.entries()) {
			newMap.set(key, value)
		}
	}
	return newMap
}

export function find<K, T>(map: Map<K, T>, predicate: (key: K, value: T) => boolean): [K, T] | undefined {
	for (const [key, value] of map.entries()) {
		if (predicate(key, value)) {
			return [key, value]
		}
	}
	return undefined
}

export function apply<K, T>(map: Map<K, T>, ...maps: Map<K, T>[]): Map<K, T> {
	for (const otherMap of maps) {
		for (const [key, value] of otherMap.entries()) {
			map.set(key, value)
		}
	}
	return map
}

export function some<K, T>(map: Map<K, T>, predicate: (key: K, value: T) => boolean): boolean {
	for (const [key, value] of map.entries()) {
		if (predicate(key, value)) {
			return true
		}
	}
	return false
}

export function revLookup<K, T>(map: Map<K, T>, value: T, toId: (value: T) => unknown = (value: T) => value): K | undefined {
	for (const [key, val] of map.entries()) {
		if (toId(val) === toId(value)) {
			return key
		}
	}
	return undefined
}

export function revLookupAll<K, T>(map: Map<K, T>, value: T, toId: (value: T) => unknown = (value: T) => value): K[] {
	const matches: K[] = []
	for (const [key, val] of map.entries()) {
		if (toId(val) === toId(value)) {
			matches.push(key)
		}
	}
	return matches
}

export function bulkDelete<K, T>(map: Map<K, T>, ...keys: K[]): Map<K, T> {
	for (const key of keys) {
		map.delete(key)
	}
	return map
}
