export function deepClone<T>(set: Set<T>): Set<T> {
	return new Set(set)
}

export function filter<T>(set: Set<T>, predicate: (value: T) => boolean): Set<T> {
	const newSet = new Set<T>()
	for (const value of set) {
		if (predicate(value)) {
			newSet.add(value)
		}
	}
	return newSet
}

export function map<T, U>(set: Set<T>, fn: (value: T) => U): Set<U> {
	const newSet = new Set<U>()
	for (const value of set) {
		newSet.add(fn(value))
	}
	return newSet
}

export function union<T>(...sets: Set<T>[]): Set<T> {
	const newSet = new Set<T>()
	for (const set of sets) {
		for (const value of set) {
			newSet.add(value)
		}
	}
	return newSet
}

export function intersection<T>(...sets: Set<T>[]): Set<T> {
	if (sets.length === 0) return new Set<T>()

	const [first, ...rest] = sets
	const newSet = new Set<T>()

	for (const value of first) {
		if (rest.every(set => set.has(value))) {
			newSet.add(value)
		}
	}
	return newSet
}

export function difference<T>(set: Set<T>, ...otherSets: Set<T>[]): Set<T> {
	const newSet = new Set<T>()
	for (const value of set) {
		if (!otherSets.some(otherSet => otherSet.has(value))) {
			newSet.add(value)
		}
	}
	return newSet
}

export function symmetricDifference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
	const newSet = new Set<T>()

	for (const value of setA) {
		if (!setB.has(value)) {
			newSet.add(value)
		}
	}

	for (const value of setB) {
		if (!setA.has(value)) {
			newSet.add(value)
		}
	}

	return newSet
}

export function find<T>(set: Set<T>, predicate: (value: T) => boolean): T | undefined {
	for (const value of set) {
		if (predicate(value)) {
			return value
		}
	}
	return undefined
}

export function apply<T>(set: Set<T>, ...otherSets: Set<T>[]): Set<T> {
	for (const otherSet of otherSets) {
		for (const value of otherSet) {
			set.add(value)
		}
	}
	return set
}

export function some<T>(set: Set<T>, predicate: (value: T) => boolean): boolean {
	for (const value of set) {
		if (predicate(value)) {
			return true
		}
	}
	return false
}

export function every<T>(set: Set<T>, predicate: (value: T) => boolean): boolean {
	for (const value of set) {
		if (!predicate(value)) {
			return false
		}
	}
	return true
}

export function bulkDelete<T>(set: Set<T>, ...values: T[]): Set<T> {
	for (const value of values) {
		set.delete(value)
	}
	return set
}

export function findWith<T>(
	set: Set<T>,
	target: T,
	compare: (a: T, b: T) => boolean,
): T | undefined {
	for (const value of set) {
		if (compare(value, target)) {
			return value
		}
	}
	return undefined
}

export function hasWith<T>(
	set: Set<T>,
	target: T,
	compare: (a: T, b: T) => boolean,
): boolean {
	for (const value of set) {
		if (compare(value, target)) {
			return true
		}
	}
	return false
}

export function isSubset<T>(subset: Set<T>, superset: Set<T>): boolean {
	for (const value of subset) {
		if (!superset.has(value)) {
			return false
		}
	}
	return true
}

export function isSuperset<T>(superset: Set<T>, subset: Set<T>): boolean {
	return isSubset(subset, superset)
}

export function isEmpty<T>(set: Set<T>): boolean {
	return set.size === 0
}

export function toArray<T>(set: Set<T>): T[] {
	return Array.from(set)
}
