export function intersect(arr1: number[], arr2: number[]): number[] {
	const result: number[] = []
	for (const num of arr1) {
		if (arr2.includes(num) && !result.includes(num)) {
			result.push(num)
		}
	}
	return result
}
