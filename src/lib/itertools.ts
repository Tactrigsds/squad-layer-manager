export function arrProduct<T>(...arrays: T[][]): T[][] {
	if (arrays.length === 0) return []
	if (arrays.length === 1) return arrays[0].map((item) => [item])

	const result: T[][] = []
	const recurse = (current: T[], index: number) => {
		if (index === arrays.length) {
			result.push([...current])
			return
		}

		for (const item of arrays[index]) {
			current.push(item)
			recurse(current, index + 1)
			current.pop()
		}
	}

	recurse([], 0)
	return result
}
