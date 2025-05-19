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
