export function intersect(arr1: number[], arr2: number[]): number[] {
	const result: number[] = []
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
