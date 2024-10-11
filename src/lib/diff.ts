/**
 * Compares two arrays and calculates structural differences with known offsets.
 * @param orig - Original array
 * @param curr - Current array
 * @param offsets - Mapping from current to original indices. Null for added elements
 * @param eq - qquality predicate
 * @returns {Object} An object containing arrays of indices for different types of changes
 * @property {number[]} added - Indices of elements added in the current array
 * @property {number[]} edited - Indices of elements that have been modified
 * @property {number[]} removed - Indices of elements removed from the original array
 * @property {number[]} moved - Indices of elements that have changed position in the current array
 */
export function structuralArrayDiffWithKnownOffsets<T>(
	orig: T[],
	curr: T[],
	offsets: (number | null)[],
	eq: (a: T, b: T) => boolean = (a, b) => a === b
): { added: number[]; edited: number[]; removed: number[]; moved: number[] } {
	if (curr.length !== offsets.length) throw new Error('current array and map must be of equal length')
	const uniqueIndexes = new Set<number>()
	for (const idx of offsets) {
		if (idx !== null) {
			if (uniqueIndexes.has(idx)) {
				throw new Error('Duplicate index found in origIdxMap')
			}
			uniqueIndexes.add(idx)
		}
	}
	const removed: number[] = []

	const edited: number[] = []
	const added: number[] = []
	const moved: number[] = []
	let expectedOrigIdxOffset = 0
	for (let i = 0; i < curr.length; i++) {
		const origIdx = offsets[i]
		const expectedOrigIdx = i + expectedOrigIdxOffset
		if (!offsets.includes(expectedOrigIdx)) {
			removed.push(expectedOrigIdx)
			expectedOrigIdxOffset++
		}
		if (origIdx === null) {
			added.push(i)
			expectedOrigIdxOffset--
			continue
		}
		if (origIdx !== expectedOrigIdx) {
			moved.push(i)
		}
		if (!eq(orig[expectedOrigIdx], curr[i])) {
			edited.push(i)
		}
	}

	return { edited, added, removed, moved }
}
