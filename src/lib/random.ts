/**
 * Selects a random value from an array based on provided weights.
 *
 * @param values Array of values to select from
 * @param weights Array of weights corresponding to each value, must be the same length as values
 * @param seed Seed value for deterministic random selection
 * @returns A randomly selected value based on the provided weights
 * @throws Error if arrays have different lengths or weights sum to zero
 */
export function weightedRandomSelection<T>(values: T[], weights: number[], rng = () => Math.random()): T {
	if (values.length !== weights.length) {
		throw new Error('Values and weights arrays must have the same length')
	}
	if (values.length === 1) return values[0]

	// Calculate the sum of all weights
	const weightSum = weights.reduce((sum, weight) => sum + weight, 0)

	if (weightSum <= 0) {
		throw new Error('Sum of weights must be greater than zero')
	}

	// Generate a random number between 0 and the sum of weights using the seed
	const randomValue = rng() * weightSum

	// Find the item that corresponds to the random value
	let cumulativeWeight = 0

	for (let i = 0; i < values.length; i++) {
		cumulativeWeight += weights[i]

		if (randomValue < cumulativeWeight) {
			return values[i]
		}
	}

	// Fallback (should never reach here if weightSum > 0)
	return values[values.length - 1]
}

/**
 * Shuffles an array using the Fisher-Yates algorithm.
 * Yields elements one at a time in shuffled order.
 *
 * @param array Array to shuffle
 * @param seed Optional seed for deterministic shuffling. If not provided, uses Math.random()
 * @yields Elements from the array in shuffled order
 */
export function* shuffled<T>(array: T[], rng = Math.random): Generator<T, void, unknown> {
	const indices = Array.from({ length: array.length }, (_, i) => i)
	let currentIndex = indices.length, randomIndex

	// While there remain elements to shuffle.
	while (currentIndex != 0) {
		// Pick a remaining element.
		randomIndex = Math.floor(rng() * currentIndex)
		currentIndex-- // And swap it with the current element.
		;[indices[currentIndex], indices[randomIndex]] = [
			indices[randomIndex],
			indices[currentIndex],
		]

		yield array[indices[currentIndex]]
	}
}
