const ID_MATCHER = /\s*(?<name>[^\s:]+)\s*:\s*(?<id>[^\s]+)/g

// COMMON CONSTANTS

/** All possible IDs that a player can have. */
export const playerIdNames: string[] = ['steamID', 'eosID']

// PARSING AND ITERATION

/**
 * Main function intended for parsing `Online IDs:` body.
 * @arg {string} idsStr - String with ids. Extra whitespace is allowed,
 *   Number of {platform: ID} pairs can be arbitrary. String example:
     " platform1:id1 platform2: id2    platform3  :  id3   "
     Keys and values are not allowed contain colons or whitespace
     characters.
 * @returns {IdsIterator} An iterator that yields {platform: ID} pairs.
 */
export const iterateIDs = (idsStr: string): IdsIterator => {
	return new IdsIterator(idsStr.matchAll(ID_MATCHER))
}

class IdsIterator {
	private inner: IterableIterator<RegExpMatchArray>

	constructor(matchIterator: IterableIterator<RegExpMatchArray>) {
		this.inner = matchIterator
	}

	[Symbol.iterator](): IterableIterator<{ key: string; value: string }> {
		return this
	}

	next(): IteratorResult<{ key: string; value: string }> {
		const match = this.inner.next()
		if (match.done) return { value: undefined, done: true }
		return {
			value: { key: match.value.groups!.name, value: match.value.groups!.id },
			done: false,
		}
	}

	forEach(callbackFn: (key: string, value: string) => void): void {
		for (const { key, value } of this) callbackFn(key, value)
	}
}

// FORMATTING

/**
 * Generates capitalized ID names. Examples:
 *   steam -> SteamID
 *   EOSID -> EOSID
 */
export const capitalID = (str: string): string => {
	return str.charAt(0).toUpperCase() + str.slice(1) + 'ID'
}

/**
 * Generates lowercase ID names. Examples:
 *   steam -> steamID
 *   EOSID -> eosID
 */
export const lowerID = (str: string): string => {
	return str.toLowerCase() + 'ID'
}
