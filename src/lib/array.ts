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

export function includesId<T extends string>(arr: T[], value: string): value is T {
	return includes(arr, value)
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
