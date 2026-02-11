import * as Obj from '@/lib/object'
import * as Im from 'immer'
import * as Rx from 'rxjs'

// -------- Loader Configuration Types --------

/**
 * Configuration options for a loader.
 * Loaders can be either synchronous or asynchronous, and support lifecycle hooks.
 */
export type LoaderConfigOptions<Key, Data = never, StoreState = unknown> =
	& {
		/** Time in ms before we unload an inactive loader. Default: no unload */
		staleTime?: number

		/** If true, the loader is unloaded immediately when leaving. Default: false */
		unloadOnLeave?: boolean

		/** Called when the loader becomes active (not preloading) */
		onEnter?: (opts: { key: Key; data: Data; draft: Im.Draft<StoreState> }) => Promise<void> | void

		/** Called when the loader is being unloaded from cache */
		onUnload?: (opts: { key: Key; data: Data | undefined; state: Im.Draft<StoreState> }) => Promise<void> | void

		/** Called when leaving (before potential unload) */
		onLeave?: (opts: { key: Key; data: Data; draft: Im.Draft<StoreState> }) => Promise<void> | void

		/**
		 * Use in cases where this loader has ephemeral external dependencies.
		 * Return true to trigger immediate unload.
		 */
		checkShouldUnload?: (opts: { key: Key; data: Data | undefined; state: StoreState }) => boolean
	}
	& ({
		load: (opts: { key: Key; preload: boolean; state: StoreState }) => Data
	} | {
		loadAsync: (opts: { key: Key; preload: boolean; state: StoreState; abortController: AbortController }) => Promise<Data>
	})

/**
 * Full loader configuration including name and match function.
 */
export type LoaderConfig<
	Name extends string = string,
	Key = any,
	Data = any,
	StoreState = any,
	MatchState = any,
> =
	& {
		name: Name
		match: (state: MatchState) => Key | undefined
	}
	& LoaderConfigOptions<Key, Data, StoreState>

// -------- Loader Cache Types --------

/**
 * A cached loader entry tracking loading state and data.
 */
export type LoaderCacheEntry<Config extends LoaderConfig, Loaded extends boolean = boolean> = {
	name: Config['name']
	key: LoaderKey<Config>
	data: Loaded extends true ? LoaderData<Config> : Loaded extends false ? undefined : LoaderData<Config> | undefined
	active: boolean
	/** Subscription to cancel scheduled unload */
	unloadSub?: Rx.Subscription
	/** AbortController for async loaders */
	loadAbortController?: AbortController
}

/** Extract the return type of a loader's load/loadAsync function */
export type LoaderResult<Config extends LoaderConfig> = Config extends { loadAsync: () => infer Result } ? Result
	: LoaderData<Config>

/** Extract the data type from a loader config */
export type LoaderData<Config extends LoaderConfig> = Config extends LoaderConfig<any, any, infer Data> ? Data
	: never

/** Extract the key type from a loader config */
export type LoaderKey<Config extends LoaderConfig> = Exclude<ReturnType<Config['match']>, undefined>

/** A fully loaded cache entry (data is guaranteed to be present) */
export type LoadedLoaderEntry<Config extends LoaderConfig> = LoaderCacheEntry<Config, true>

/**
 * Creates a discriminated union of loader cache entries from a tuple of configs.
 * This allows TypeScript to narrow the type when checking the `name` property.
 *
 * @example
 * ```ts
 * const LOADERS = [loaderA, loaderB] as const
 * type LoadedEntry = LoaderCacheEntryUnion<typeof LOADERS, true>
 * // Now `if (entry.name === 'a')` will narrow entry.data and entry.key
 * ```
 */
export type LoaderCacheEntryUnion<
	Configs extends readonly LoaderConfig[],
	Loaded extends boolean = boolean,
> = {
	[K in keyof Configs]: Configs[K] extends LoaderConfig ? LoaderCacheEntry<Configs[K], Loaded>
		: never
}[number]

// -------- Type Guards --------

/**
 * Type guard to check if a loader config has a synchronous load function.
 */
export function hasSyncLoader<Config extends LoaderConfig>(
	config: Config,
): config is Extract<Config, { load: (...args: any[]) => any }> {
	return typeof (config as any).load === 'function'
}

/**
 * Type guard to check if a loader config has an asynchronous loadAsync function.
 */
export function hasAsyncLoader<Config extends LoaderConfig>(
	config: Config,
): config is Extract<Config, { loadAsync: (...args: any[]) => any }> {
	return typeof (config as any).loadAsync === 'function'
}

// -------- Loader Config Factory --------

/**
 * Factory function to create a typed loader configuration.
 * Returns a function that accepts loader options and returns the full config.
 *
 * @example
 * ```ts
 * const myLoader = createLoaderConfig(
 *   'myLoader',
 *   (state) => state.someKey?.id === 'MY_KEY' ? state.someKey : undefined
 * )({
 *   load: ({ key }) => ({ data: key.someData }),
 *   onUnload: () => console.log('unloaded'),
 * })
 * ```
 */
export function createLoaderConfig<
	Name extends string,
	Key,
	MatchState,
>(
	name: Name,
	match: (state: MatchState) => Key | undefined,
) {
	return <Data, StoreState = unknown>(
		config: LoaderConfigOptions<Key, Data, StoreState>,
	): LoaderConfig<Name, Key, Data, StoreState, MatchState> => ({
		name,
		match,
		...config,
	})
}

// -------- Lifecycle Event Dispatch --------

export type LoaderManagerContext<
	Config extends LoaderConfig,
	StoreState,
> = {
	configs: readonly Config[]
	getCache: (draft: Im.Draft<StoreState>) => LoaderCacheEntry<Config>[]
	setCache: (draft: Im.Draft<StoreState>, cache: LoaderCacheEntry<Config>[]) => void
	set: (updater: (state: StoreState) => StoreState) => void
	getCurrentState: () => StoreState
}

/**
 * Dispatches loader lifecycle events when match state changes.
 * Handles loading, unloading, and lifecycle hooks for loaders.
 */
export function dispatchLoaderEvents<
	Config extends LoaderConfig,
	StoreState,
	MatchState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	updated: MatchState | null,
	prev: MatchState | null,
	preloading: boolean,
) {
	ctx.set(Im.produce<StoreState>(draft => {
		const loaderCache = ctx.getCache(draft)
		if (updated == prev) return
		for (const config of ctx.configs) {
			const cacheKey = updated ? config.match(updated) : undefined
			const prevCacheKey = prev ? config.match(prev) : undefined
			if (Obj.deepEqual(cacheKey, prevCacheKey)) continue
			if (!cacheKey) {
				if (!prevCacheKey || preloading) continue
				for (const entry of loaderCache) {
					if (!entry.active || !Obj.deepEqual(prevCacheKey, entry.key)) continue
					if (!loaderCache.includes(entry)) return
					if (config.unloadOnLeave) {
						unloadLoaderEntry(ctx, config, prevCacheKey, draft)
					} else {
						entry.unloadSub = scheduleUnloadLoaderEntry(ctx, config, prevCacheKey)
					}
					if (config.onLeave) {
						entry.active = false
						void config.onLeave({
							key: prevCacheKey,
							data: Im.current(entry.data!) as LoaderData<typeof config>,
							draft,
						})
					}
				}
				continue
			}
			const existingEntry = loaderCache.find(e => Obj.deepEqual(e.key, cacheKey))
			let cacheEntry: LoaderCacheEntry<typeof config>
			let isNewAsyncEntry = false
			if (!existingEntry) {
				cacheEntry = { name: config.name, key: cacheKey, active: undefined!, data: undefined }
				const args = { key: cacheKey, preload: preloading, state: Im.current(draft) as StoreState }
				if (hasSyncLoader(config)) {
					const data = config.load(args)
					cacheEntry.data = data
				} else if (hasAsyncLoader(config)) {
					const controller = new AbortController()
					cacheEntry.loadAbortController = controller
					isNewAsyncEntry = true
					startAsyncLoad(
						ctx,
						config,
						cacheKey,
						Im.current(draft) as StoreState,
						preloading,
						controller,
						!preloading
							? (data, draft) => {
								const cache = ctx.getCache(draft)
								const entry = cache.find(e => Obj.deepEqual(e.key, cacheKey))
								if (entry) {
									entry.active = true
									entry.unloadSub?.unsubscribe()
									delete entry.unloadSub
								}
								void config.onEnter?.({ key: cacheKey, data, draft })
							}
							: undefined,
					)
				}

				loaderCache.push(cacheEntry)
			} else {
				cacheEntry = existingEntry as LoaderCacheEntry<typeof config>
			}
			if (preloading) {
				if (cacheEntry.active) continue
				cacheEntry.active = false
				cacheEntry.unloadSub?.unsubscribe()
				cacheEntry.unloadSub = scheduleUnloadLoaderEntry(ctx, config as any, cacheKey as any)
			} else {
				if (cacheEntry.data) {
					cacheEntry.active = true
					cacheEntry.unloadSub?.unsubscribe()
					delete cacheEntry.unloadSub
					void config.onEnter?.({ key: cacheKey, data: cacheEntry.data, draft: draft })
				} else if (!isNewAsyncEntry && !cacheEntry.data && cacheEntry.loadAbortController) {
					// Existing entry with an in-flight async load (e.g. from preload).
					// Restart the load with an onComplete callback so onEnter fires.
					const existingController = cacheEntry.loadAbortController
					const controller = new AbortController()
					cacheEntry.loadAbortController = controller
					existingController.abort('replaced')
					startAsyncLoad(ctx, config as any, cacheKey, Im.current(draft) as StoreState, false, controller, (data, draft) => {
						const cache = ctx.getCache(draft)
						const entry = cache.find(e => Obj.deepEqual(e.key, cacheKey))
						if (entry) {
							entry.active = true
							entry.unloadSub?.unsubscribe()
							delete entry.unloadSub
						}
						void config.onEnter?.({ key: cacheKey, data, draft })
					})
				}
			}
		}
	}))
}

/**
 * Unloads a loader entry from the cache, calling onUnload if defined.
 */
export function unloadLoaderEntry<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	config: Config,
	key: LoaderKey<Config>,
	draft: Im.Draft<StoreState>,
) {
	const loaderCache = ctx.getCache(draft)
	const cacheEntry = loaderCache.find(e => Obj.deepEqual(e.key, key))
	if (!cacheEntry) return
	ctx.setCache(draft, loaderCache.filter(e => !Obj.deepEqual(e.key, key)))
	if (config.onUnload) {
		const args = { key, data: Im.current(cacheEntry.data), state: draft }
		void config.onUnload(args)
	}
	cacheEntry?.loadAbortController?.abort('unloaded')
}

/**
 * Schedules an unload after the configured staleTime.
 * Returns a subscription that can be used to cancel the scheduled unload.
 */
function scheduleUnloadLoaderEntry<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	config: Config,
	key: LoaderKey<Config>,
): Rx.Subscription | undefined {
	if (config.staleTime === undefined) return

	return Rx.of(1).pipe(Rx.delay(config.staleTime)).subscribe(() => {
		ctx.set(Im.produce<StoreState>(draft => {
			unloadLoaderEntry(ctx, config, key, draft)
		}))
	})
}

// -------- Cache Entry Upsert --------

/**
 * Starts an async load operation and sets up a subscription to update the cache when complete.
 */
function startAsyncLoad<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	config: Extract<Config, { loadAsync: (...args: any[]) => any }>,
	key: LoaderKey<Config>,
	state: StoreState,
	preload: boolean,
	controller: AbortController,
	onComplete?: (data: LoaderData<typeof config>, draft: Im.Draft<StoreState>) => void,
): void {
	const load$ = Rx.race(
		Rx.from(config.loadAsync({ key, preload, state, abortController: controller }).catch(() => undefined)),
		Rx.fromEvent(controller.signal, 'abort', { once: true }).pipe(Rx.map(() => undefined)),
	)

	load$.subscribe((data: LoaderData<typeof config> | undefined) => {
		if (data === undefined) return
		ctx.set(Im.produce<StoreState>(draft => {
			const cache = ctx.getCache(draft)
			const entry = cache.find(e => Obj.deepEqual(e.key, key))
			if (entry) {
				entry.data = data
				delete entry.loadAbortController
				onComplete?.(data, draft)
			}
		}))
	})
}

/**
 * Inserts or replaces a cache entry matching the given key.
 * If no entry with a matching key exists, the new entry is appended.
 * If an entry with a matching key exists, it is replaced in-place.
 */
function upsertCacheEntry<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	draft: Im.Draft<StoreState>,
	entry: LoaderCacheEntry<Config>,
) {
	const cache = ctx.getCache(draft)
	const idx = cache.findIndex(e => Obj.deepEqual(e.key, entry.key))
	if (idx === -1) {
		cache.push(entry)
	} else {
		cache[idx].unloadSub?.unsubscribe()
		cache[idx].loadAbortController?.abort('replaced')
		cache[idx] = entry
	}
}

/**
 * Preloads a cache entry for the given config and key.
 * The entry is inserted if no matching key exists, otherwise replaced.
 * A preloaded entry is inactive and will be scheduled for unload per the config's staleTime.
 * Invokes the loader (sync or async) internally.
 */
export function preloadCacheEntry<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	config: Config,
	key: LoaderKey<Config>,
	draft: Im.Draft<StoreState>,
) {
	const state = Im.current(draft) as StoreState

	if (hasSyncLoader(config)) {
		const data = config.load({ key, preload: true, state })
		upsertCacheEntry(ctx, draft, {
			name: config.name,
			key,
			data,
			active: false,
			unloadSub: scheduleUnloadLoaderEntry(ctx, config, key),
		})
	} else if (hasAsyncLoader(config)) {
		const controller = new AbortController()
		upsertCacheEntry(ctx, draft, {
			name: config.name,
			key,
			data: undefined,
			active: false,
			loadAbortController: controller,
			unloadSub: scheduleUnloadLoaderEntry(ctx, config, key),
		})

		startAsyncLoad(ctx, config, key, state, true, controller)
	}
}

/**
 * Loads a cache entry for the given config and key, marking it as active.
 * The entry is inserted if no matching key exists, otherwise replaced.
 * Invokes the loader (sync or async) internally.
 * Fires the config's onEnter hook when data is available.
 */
export function loadCacheEntry<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	config: Config,
	key: LoaderKey<Config>,
	draft: Im.Draft<StoreState>,
) {
	const state = Im.current(draft) as StoreState

	if (hasSyncLoader(config)) {
		const data = config.load({ key, preload: false, state })
		upsertCacheEntry(ctx, draft, {
			name: config.name,
			key,
			data,
			active: true,
		})
		void config.onEnter?.({ key, data, draft })
	} else if (hasAsyncLoader(config)) {
		const controller = new AbortController()
		upsertCacheEntry(ctx, draft, {
			name: config.name,
			key,
			data: undefined,
			active: true,
			loadAbortController: controller,
		})

		startAsyncLoad(ctx, config, key, state, false, controller, (data, draft) => {
			void config.onEnter?.({ key, data, draft })
		})
	}
}

/**
 * Closes/deactivates a cache entry, calling onLeave and handling unload based on config.
 * If config.unloadOnLeave is true, immediately unloads the entry.
 * Otherwise, marks the entry as inactive and schedules unload based on staleTime.
 */
export function closeCacheEntry<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	config: Config,
	key: LoaderKey<Config>,
	draft: Im.Draft<StoreState>,
) {
	const loaderCache = ctx.getCache(draft)
	const cacheEntry = loaderCache.find(e => Obj.deepEqual(e.key, key))
	if (!cacheEntry || !cacheEntry.active) return

	// Call onLeave if defined
	if (config.onLeave && cacheEntry.data) {
		void config.onLeave({
			key,
			data: Im.current(cacheEntry.data) as LoaderData<typeof config>,
			draft,
		})
	}

	// Either unload immediately or schedule for later
	if (config.unloadOnLeave) {
		unloadLoaderEntry(ctx, config, key, draft)
	} else {
		cacheEntry.active = false
		cacheEntry.unloadSub?.unsubscribe()
		cacheEntry.unloadSub = scheduleUnloadLoaderEntry(ctx, config, key)
	}
}

/**
 * Checks all loader entries and unloads any that should be unloaded
 * based on their checkShouldUnload predicate.
 */
export function checkAndUnloadStaleEntries<
	Config extends LoaderConfig,
	StoreState,
>(
	ctx: LoaderManagerContext<Config, StoreState>,
	state: StoreState,
) {
	const cache = ctx.getCache(state as Im.Draft<StoreState>)
	for (const entry of cache) {
		const config = ctx.configs.find(e => e.name === entry.name)
		if (!config?.checkShouldUnload) continue

		const shouldUnload = config.checkShouldUnload({ key: entry.key, data: entry.data, state })
		if (shouldUnload) {
			ctx.set(Im.produce<StoreState>(draft => {
				unloadLoaderEntry(ctx, config, entry.key, draft)
			}))
		}
	}
}
