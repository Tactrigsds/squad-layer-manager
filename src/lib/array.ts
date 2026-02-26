export function intersect<T>(arr1: T[], arr2: T[]): T[] {
	const result: T[] = []
	for (const num of arr1) {
		if (arr2.includes(num) && !result.includes(num)) {
			result.push(num)
		}
	}
	return result
}

export function cartesianProduct<T, U>(arr1: T[], arr2: U[]): [T, U][] {
	const result: [T, U][] = []
	for (const item1 of arr1) {
		for (const item2 of arr2) {
			result.push([item1, item2])
		}
	}
	return result
}

export function union<T>(arr1: T[], arr2: T[]): T[] {
	const result: T[] = []
	for (const num of arr1) {
		if (!result.includes(num)) {
			result.push(num)
		}
	}
	for (const num of arr2) {
		if (!result.includes(num)) {
			result.push(num)
		}
	}
	return result
}

export function includes(arr: unknown[], value: unknown): boolean {
	return arr.includes(value)
}

export function includesId<T extends string>(arr: readonly T[], value: string): value is T {
	return includes(arr as T[], value)
}

export function upsert<T>(arr: T[], item: T, predicate?: (existing: T, item: T) => boolean): void {
	for (let i = 0; i < arr.length; i++) {
		const matches = predicate ? predicate(arr[i], item) : arr[i] === item
		if (matches) {
			arr[i] = item
			return
		}
	}
	arr.push(item)
}

export function upsertOn<T, K extends keyof T>(arr: T[], item: T, key: K): void {
	for (let i = 0; i < arr.length; i++) {
		if (arr[i][key] === item[key]) {
			arr[i] = item
			return
		}
	}
	arr.push(item)
}

export function coalesceArr<T>(input: T | T[]): T[] {
	if (Array.isArray(input)) return input
	return [input]
}

export function last<T>(arr: T[]): T | undefined {
	return arr[arr.length - 1]
}

export function delta<T>(before: T[], after: T[]): { added: T[]; removed: T[] } {
	const added = after.filter(item => !before.includes(item))
	const removed = before.filter(item => !after.includes(item))
	return { added, removed }
}

export function deref<Entry extends { [key: string]: unknown }>(key: keyof Entry, arr: Entry[]) {
	return arr.map((entry) => entry[key])
}

export function dedupe<T>(arr: T[]): T[] {
	return Array.from(new Set(arr))
}

export function destrOptional<Arr extends unknown[]>(arr: Arr | undefined) {
	if (arr) return arr
	return [] as Arr | undefined[]
}

export function missing<T>(arr: T[], target: T[]): T[] {
	return arr.filter(item => !target.includes(item))
}

export function isSubset<T>(superset: T[], subset: T[]): boolean {
	return subset.every(item => superset.includes(item))
}

export function paged<T>(arr: T[], pageSize: number): T[][] {
	const result: T[][] = []
	for (let i = 0; i < arr.length; i += pageSize) {
		result.push(arr.slice(i, i + pageSize))
	}
	return result
}

export function revFind<T>(arr: T[], predicate: (item: T) => boolean): T | undefined
export function revFind<T>(arr: T[], startIndex: number, predicate: (item: T) => boolean): T | undefined
export function revFind<T>(
	arr: T[],
	predicateOrStartIndex: ((item: T) => boolean) | number,
	predicate?: (item: T) => boolean,
): T | undefined {
	let actualPredicate: (item: T) => boolean
	let startIndex: number

	if (typeof predicateOrStartIndex === 'function') {
		actualPredicate = predicateOrStartIndex
		startIndex = arr.length - 1
	} else {
		actualPredicate = predicate!
		startIndex = predicateOrStartIndex
	}

	for (let i = startIndex; i >= 0; i--) {
		if (actualPredicate(arr[i])) {
			return arr[i]
		}
	}
	return undefined
}

export function revFindMany<T>(arr: T[], predicate: (item: T, index: number) => boolean, count: number): T[] {
	const result: T[] = []
	for (let i = arr.length - 1; i >= 0; i--) {
		if (predicate(arr[i], i)) {
			result.push(arr[i])
			if (result.length === count) {
				break
			}
		}
	}
	return result
}

export function revFindIndex<T>(arr: T[], predicate: (item: T, index: number) => boolean): number {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (predicate(arr[i], i)) {
			return i
		}
	}
	return -1
}

export function* revIter<T>(arr: T[]): Generator<T> {
	for (let i = arr.length - 1; i >= 0; i--) {
		yield arr[i]
	}
}

export function partition<T, S extends T>(arr: T[], predicate: (item: T) => item is S): [S[], Exclude<T, S>[]]
export function partition<T>(arr: T[], predicate: (item: T) => boolean): [T[], T[]]
export function partition<T>(arr: T[], predicate: (item: T) => boolean): [T[], T[]] {
	const truthy: T[] = []
	const falsy: T[] = []
	for (const item of arr) {
		if (predicate(item)) {
			truthy.push(item)
		} else {
			falsy.push(item)
		}
	}
	return [truthy, falsy]
}
