/**
 * Selects a random value from an array based on provided weights.
 *
 * @param values Array of values to select from
 * @param weights Array of weights corresponding to each value, must be the same length as values
 * @returns A randomly selected value based on the provided weights
 * @throws Error if arrays have different lengths or weights sum to zero
 */
export function weightedRandomSelection<T>(values: T[], weights: number[]): T {
	if (values.length !== weights.length) {
		throw new Error('Values and weights arrays must have the same length')
	}
	if (values.length === 1) return values[0]

	// Calculate the sum of all weights
	const weightSum = weights.reduce((sum, weight) => sum + weight, 0)

	if (weightSum <= 0) {
		throw new Error('Sum of weights must be greater than zero')
	}

	// Generate a random number between 0 and the sum of weights
	const random = Math.random() * weightSum

	// Find the item that corresponds to the random value
	let cumulativeWeight = 0

	for (let i = 0; i < values.length; i++) {
		cumulativeWeight += weights[i]

		if (random < cumulativeWeight) {
			return values[i]
		}
	}

	// Fallback (should never reach here if weightSum > 0)
	return values[values.length - 1]
}
