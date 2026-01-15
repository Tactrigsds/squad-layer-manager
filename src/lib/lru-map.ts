/**
 * A Map implementation with a fixed maximum size that evicts the oldest entry
 * when the capacity is exceeded.
 *
 * Uses a Least Recently Used (LRU) eviction strategy where entries are tracked
 * by insertion order, and the oldest entry is removed when adding a new entry
 * would exceed the capacity.
 */
export class FixedSizeMap<K, V> extends Map<K, V> {
	private readonly maxSize: number

	/**
	 * Creates a new FixedSizeMap with the specified maximum size.
	 *
	 * @param maxSize - The maximum number of entries the map can hold
	 * @param entries - Optional initial entries for the map
	 * @throws {Error} If maxSize is less than 1
	 */
	constructor(maxSize: number, entries?: ReadonlyArray<readonly [K, V]> | null) {
		super(entries)

		if (maxSize < 1) {
			throw new Error('maxSize must be at least 1')
		}

		this.maxSize = maxSize

		// If initial entries exceed maxSize, evict oldest entries
		while (this.size > this.maxSize) {
			this.evictOldest()
		}
	}

	/**
	 * Sets a key-value pair in the map. If adding this entry would exceed
	 * the maximum size, the oldest entry is evicted first.
	 *
	 * @param key - The key to set
	 * @param value - The value to associate with the key
	 * @returns This FixedSizeMap instance for chaining
	 */
	set(key: K, value: V): this {
		// If key already exists, delete it first to update its position
		if (this.has(key)) {
			this.delete(key)
		} else if (this.size >= this.maxSize) {
			// If we're at capacity and adding a new key, evict the oldest
			this.evictOldest()
		}

		// Add the new entry (will be the newest)
		super.set(key, value)
		return this
	}

	/**
	 * Gets a value by key. This does NOT update the entry's position
	 * in the eviction order (remains at its original insertion position).
	 *
	 * @param key - The key to look up
	 * @returns The value associated with the key, or undefined if not found
	 */
	get(key: K): V | undefined {
		return super.get(key)
	}

	/**
	 * Evicts the oldest entry from the map.
	 *
	 * @returns true if an entry was evicted, false if the map was empty
	 */
	private evictOldest(): boolean {
		const firstKey = this.keys().next().value
		if (firstKey !== undefined) {
			return this.delete(firstKey)
		}
		return false
	}

	/**
	 * Gets the maximum size of the map.
	 *
	 * @returns The maximum number of entries the map can hold
	 */
	getMaxSize(): number {
		return this.maxSize
	}

	/**
	 * Checks if the map is at full capacity.
	 *
	 * @returns true if the map has reached its maximum size
	 */
	isFull(): boolean {
		return this.size >= this.maxSize
	}

	/**
	 * Gets the oldest entry in the map (the next to be evicted).
	 *
	 * @returns A tuple of [key, value] for the oldest entry, or undefined if empty
	 */
	getOldest(): [K, V] | undefined {
		const firstEntry = this.entries().next().value
		return firstEntry
	}

	/**
	 * Gets the newest entry in the map (the most recently added).
	 *
	 * @returns A tuple of [key, value] for the newest entry, or undefined if empty
	 */
	getNewest(): [K, V] | undefined {
		let lastEntry: [K, V] | undefined
		for (const entry of this.entries()) {
			lastEntry = entry
		}
		return lastEntry
	}

	/**
	 * Creates a new FixedSizeMap from an existing Map or iterable.
	 *
	 * @param maxSize - The maximum size for the new map
	 * @param source - Source Map or iterable of key-value pairs
	 * @returns A new FixedSizeMap instance
	 */
	static from<K, V>(
		maxSize: number,
		source: Map<K, V> | Iterable<readonly [K, V]>,
	): FixedSizeMap<K, V> {
		const entries = source instanceof Map ? Array.from(source.entries()) : Array.from(source)
		return new FixedSizeMap(maxSize, entries)
	}
}

/**
 * A variant of FixedSizeMap that updates entry positions on access,
 * implementing a true LRU cache where recently accessed items are
 * less likely to be evicted.
 */
export class LRUMap<K, V> extends FixedSizeMap<K, V> {
	/**
	 * Gets a value by key and moves it to the end (making it the newest).
	 * This implements true LRU behavior where accessed items become "fresh".
	 *
	 * @param key - The key to look up
	 * @returns The value associated with the key, or undefined if not found
	 */
	get(key: K): V | undefined {
		const value = super.get(key)
		if (value !== undefined) {
			// Re-insert to move to the end
			super.delete(key)
			super.set(key, value)
		}
		return value
	}

	/**
	 * Checks if a key exists and moves it to the end if it does.
	 *
	 * @param key - The key to check
	 * @returns true if the key exists in the map
	 */
	has(key: K): boolean {
		const exists = super.has(key)
		if (exists) {
			// Touch the entry to move it to the end
			const value = super.get(key)
			if (value !== undefined) {
				super.delete(key)
				super.set(key, value)
			}
		}
		return exists
	}
}
