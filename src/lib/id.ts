const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
if (characters.length !== 64) {
	throw new Error('characters length must be 64')
}

/**
 * Generates a URL-safe random ID with 6 bits of entropy per character. Why not just use base64 encoding? Because I like including ids in slugs sometimes.
 */
export function createId(size: number) {
	const result: string[] = []
	const arr = new Uint8Array(Math.ceil(size * (6 / 8)))
	crypto.getRandomValues(arr)

	let excess = 0
	for (let i = 0; i < arr.length; i++) {
		const entropy = arr[i]
		// we have two extra bits per character on every uint8, so save them here and append them once we accumulate 6 bits of entropy
		excess += entropy % 4 << ((i % 3) * 2)
		if (i % 3 === 0) {
			result.push(characters[excess])
			if (result.length === size) return result.join('')
			excess = 0
		}

		result.push(characters[entropy >> 2])
		if (result.length === size) return result.join('')
	}

	throw new Error('ran out of entropy somehow')
}
