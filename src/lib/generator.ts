export function* map<T, U>(iterable: Iterable<T>, mapper: (item: T) => U | Generator<U>): Generator<U> {
	for (const item of iterable) {
		const result = mapper(item)
		if (result instanceof Object && Symbol.iterator in result) {
			yield* result as Generator<U>
		} else {
			yield result as U
		}
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

export function find<T>(iterable: Iterable<T>, predicate: (item: T) => boolean): T | undefined {
	for (const item of iterable) {
		if (predicate(item)) {
			return item
		}
	}
	return undefined
}

export function some<T>(iterable: Iterable<T>, predicate: (item: T) => boolean): boolean {
	for (const item of iterable) {
		if (predicate(item)) {
			return true
		}
	}
	return false
}

export function* counter(count = 0): Generator<number, never> {
	while (true) {
		yield count
		count++
	}
}

export function* counterBigint(count = 0n): Generator<bigint, never> {
	while (true) {
		yield count
		count++
	}
}

export function* range(start: number, end?: number, step: number = 1): Generator<number> {
	let startValue: number
	let endValue: number
	let stepValue: number

	if (end === undefined) {
		startValue = 0
		endValue = start
		stepValue = step
	} else {
		startValue = start
		endValue = end
		stepValue = step
	}

	if (stepValue === 0) {
		throw new Error('range() step argument must not be zero')
	}

	if (stepValue > 0) {
		for (let i = startValue; i < endValue; i += stepValue) {
			yield i
		}
	} else {
		for (let i = startValue; i > endValue; i += stepValue) {
			yield i
		}
	}
}
