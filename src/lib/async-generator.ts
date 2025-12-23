export async function* map<T, U>(
	iterable: AsyncIterable<T>,
	mapper: (item: T) => U | AsyncGenerator<U> | Promise<U>,
): AsyncGenerator<U> {
	for await (const item of iterable) {
		const result = await mapper(item)
		if (result instanceof Object && Symbol.asyncIterator in result) {
			yield* result as AsyncGenerator<U>
		} else {
			yield result as U
		}
	}
}

export async function* filter<T>(
	iterable: AsyncIterable<T>,
	predicate: (item: T) => boolean | Promise<boolean>,
): AsyncGenerator<T> {
	for await (const item of iterable) {
		if (await predicate(item)) {
			yield item
		}
	}
}

export async function hasValues(iterable: AsyncIterable<unknown>): Promise<boolean> {
	for await (const _ of iterable) {
		return true
	}
	return false
}

export async function find<T>(
	iterable: AsyncIterable<T>,
	predicate: (item: T) => boolean | Promise<boolean>,
): Promise<T | undefined> {
	for await (const item of iterable) {
		if (await predicate(item)) {
			return item
		}
	}
	return undefined
}

export async function some<T>(
	iterable: AsyncIterable<T>,
	predicate: (item: T) => boolean | Promise<boolean>,
): Promise<boolean> {
	for await (const item of iterable) {
		if (await predicate(item)) {
			return true
		}
	}
	return false
}

export async function* counter(count = 0): AsyncGenerator<number, never> {
	while (true) {
		yield count
		count++
	}
}

export async function* counterBigint(count = 0n): AsyncGenerator<bigint, never> {
	while (true) {
		yield count
		count++
	}
}
