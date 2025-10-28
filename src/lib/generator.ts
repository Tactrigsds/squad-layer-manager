export function* map<T, U>(iterable: Iterable<T>, mapper: (item: T) => U): Generator<U> {
	for (const item of iterable) {
		yield mapper(item)
	}
}

export function* filter<T>(iterable: Iterable<T>, predicate: (item: T) => boolean): Generator<T> {
	for (const item of iterable) {
		if (predicate(item)) {
			yield item
		}
	}
}

export function hasValues(iterable: Iterable<unknown>): boolean {
	for (const _ of iterable) {
		return true
	}
	return false
}
