import * as Lifecycle from '@/lib/lifecycle'

import * as Im from 'immer'
import React from 'react'
import * as Zus from 'zustand'

// ============================================================================
// Types
// ============================================================================

export type InitialPosition = 'above' | 'below' | 'left' | 'right' | 'viewport-center'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WindowDefinition<TProps = any, TData = any> {
	type: string
	component: React.ComponentType<TProps>
	getId: (props: TProps) => string
	initialPosition?: InitialPosition
	defaultPinned?: boolean
	offset?: number
	collisionPadding?: number
	/** Synchronous loader - called when window opens */
	load?: (opts: { props: TProps; state: DraggableWindowStoreState }) => TData
	/** Async loader - called when window opens */
	loadAsync?: (opts: { props: TProps; state: DraggableWindowStoreState; abortController: AbortController }) => Promise<TData>
	/** Called when window becomes active (after load completes) */
	onEnter?: (opts: { props: TProps; data: TData }) => void | Promise<void>
	/** Called when window is closed */
	onLeave?: (opts: { props: TProps; data: TData }) => void | Promise<void>
	/** Called when loader data is being unloaded */
	onUnload?: (opts: { props: TProps; data: TData | undefined }) => void | Promise<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WindowState<TProps = any> = {
	anchorRect: DOMRect | null
	zIndex: number
	isPinned: boolean
	id: string
	type: string
	outletKey: unknown
	props: TProps
}

type WindowLoaderKey<TProps = any> = { type: string; windowId: string; props: TProps; outletKey: unknown }

type WindowLoaderConfig = Lifecycle.LoaderConfig<string, WindowLoaderKey, any, DraggableWindowStoreState, WindowState[]>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WindowLoaderCacheEntry<TProps = any, TData = any> = Lifecycle.LoaderCacheEntry<
	Lifecycle.LoaderConfig<string, WindowLoaderKey<TProps>, TData, DraggableWindowStoreState, WindowState[]>
>

export interface DraggableWindowStoreState {
	definitions: WindowDefinition[]
	windows: WindowState[]
	loaderCache: Lifecycle.LoaderCacheEntry<WindowLoaderConfig>[]
	zIndexCounter: number
}

interface DraggableWindowStore extends DraggableWindowStoreState {
	// Actions
	registerDefinition: <TProps, TData>(def: WindowDefinition<TProps, TData>) => void
	unregisterDefinition: (type: string) => void
	preloadWindow: <TProps>(type: string, props: TProps, outletKey?: unknown) => void
	openWindow: <TProps>(type: string, props: TProps, anchor?: HTMLElement | null, outletKey?: unknown) => void
	closeWindow: (id: string) => void
	bringToFront: (id: string) => void
	setIsPinned: (id: string, pinned: boolean) => void
}

interface DraggableWindowOutletContextValue {
	outletKey: unknown
	getElement?: () => HTMLElement | null | undefined
}

export const DraggableWindowOutletContext = React.createContext<DraggableWindowOutletContextValue | null>(null)
const DEFAULT_OUTLET_KEY = 'default'
const BASE_Z_INDEX = 0

function defToLoaderConfig(def: WindowDefinition): WindowLoaderConfig {
	return {
		name: def.type,
		match: (windows: WindowState[]) => {
			const win = windows.find(w => w.type === def.type)
			return win ? { windowId: win.id, props: win.props, type: win.type, outletKey: win.outletKey } : undefined
		},
		unloadOnLeave: false,
		...(def.load
			? {
				load: ({ key, state }: { key: WindowLoaderKey; state: DraggableWindowStoreState }) => def.load!({ props: key.props, state }),
			}
			: def.loadAsync
			? {
				loadAsync: (
					{ key, abortController, state }: { key: WindowLoaderKey; abortController: AbortController; state: DraggableWindowStoreState },
				) => def.loadAsync!({ props: key.props, state, abortController }),
			}
			: { load: () => undefined }),
		onEnter: def.onEnter
			? ({ key, data }: { key: WindowLoaderKey; data: any }) => {
				void def.onEnter!({ props: key.props, data })
			}
			: undefined,
		onLeave: def.onLeave
			? ({ key, data }: { key: WindowLoaderKey; data: any }) => {
				void def.onLeave!({ props: key.props, data })
			}
			: undefined,
		onUnload: def.onUnload
			? ({ key, data }: { key: WindowLoaderKey; data: any }) => {
				void def.onUnload!({ props: key.props, data })
			}
			: undefined,
	} as WindowLoaderConfig
}

export const DraggableWindowStore = (() => {
	const loaderConfigs: WindowLoaderConfig[] = []

	const store = Zus.createStore<DraggableWindowStore>((set, get) => {
		const loaderCtx: Lifecycle.LoaderManagerContext<WindowLoaderConfig, DraggableWindowStoreState> = {
			configs: loaderConfigs,
			getCache: (draft) => draft.loaderCache as Lifecycle.LoaderCacheEntry<WindowLoaderConfig>[],
			setCache: (draft, cache) => {
				draft.loaderCache = cache
			},
			set: (updater) => set(updater),
			getCurrentState: () => get(),
		}

		return {
			definitions: [],
			windows: [],
			loaderCache: [],
			zIndexCounter: BASE_Z_INDEX,

			registerDefinition: (def) => {
				const idx = loaderConfigs.findIndex(c => c.name === def.type)
				const config = defToLoaderConfig(def)
				if (idx >= 0) {
					loaderConfigs[idx] = config
				} else {
					loaderConfigs.push(config)
				}

				set((s) => ({
					definitions: [...s.definitions.filter(d => d.type !== def.type), def],
				}))
			},

			unregisterDefinition: (id) => {
				const idx = loaderConfigs.findIndex(c => c.name === id)
				if (idx >= 0) loaderConfigs.splice(idx, 1)

				set((s) => ({
					definitions: s.definitions.filter((d) => d.type !== id),
				}))
			},

			preloadWindow: (id, props, outletKey) => {
				requestIdleCallback(() => {
					const def = get().definitions.find((d) => d.type === id)
					if (!def) {
						console.warn(`DraggableWindow: No definition found for id "${id}"`)
						return
					}

					const config = loaderConfigs.find((c) => c.name === id)
					if (!config) return

					const windowId = def.getId(props)
					const key: WindowLoaderKey = { type: id, windowId, props, outletKey: outletKey ?? DEFAULT_OUTLET_KEY }

					loaderCtx.set(Im.produce<DraggableWindowStoreState>((draft) => {
						Lifecycle.preloadCacheEntry(loaderCtx as any, config, key, draft)
					}))
				})
			},

			openWindow: (id, props, anchor, outletKey) => {
				const { definitions, windows, zIndexCounter } = get()
				const def = definitions.find((d) => d.type === id)
				if (!def) {
					console.warn(`DraggableWindow: No definition found for id "${id}"`)
					return
				}

				const windowId = def.getId(props)
				if (windows.find((w) => w.id === windowId)) return

				const resolvedOutletKey = outletKey ?? DEFAULT_OUTLET_KEY
				const config = loaderConfigs.find((c) => c.name === id)
				const key: WindowLoaderKey = { type: id, windowId, props, outletKey: resolvedOutletKey }
				const anchorRect = anchor?.getBoundingClientRect() ?? null
				const openState: WindowState = {
					id: windowId,
					type: id,
					props,
					anchorRect,
					zIndex: zIndexCounter + 1,
					isPinned: def.defaultPinned ?? false,
					outletKey: resolvedOutletKey,
				}

				loaderCtx.set(Im.produce<DraggableWindowStoreState>((draft) => {
					draft.windows = [...draft.windows, openState]
					draft.zIndexCounter += 1
					if (config) {
						Lifecycle.loadCacheEntry(loaderCtx as any, config, key, draft)
					}
				}))
			},

			closeWindow: (id) => {
				const state = get()
				const window = state.windows.find((w) => w.id === id)
				if (!window) return

				const config = loaderConfigs.find((c) => c.name === window.type)
				if (config) {
					const key: WindowLoaderKey = { type: window.type, windowId: window.id, props: window.props, outletKey: window.outletKey }
					loaderCtx.set(Im.produce<DraggableWindowStoreState>((draft) => {
						draft.windows = draft.windows.filter((w) => w.id !== id)
						Lifecycle.closeCacheEntry(loaderCtx as any, config, key, draft)
					}))
				} else {
					set((s) => ({
						windows: s.windows.filter((w) => w.id !== id),
					}))
				}
			},

			bringToFront: (id) =>
				set((s) => ({
					windows: s.windows.map((w) => w.id === id ? { ...w, zIndex: s.zIndexCounter + 1 } : w),
					zIndexCounter: s.zIndexCounter + 1,
				})),

			setIsPinned: (id, isPinned) =>
				set((s) => ({
					windows: s.windows.map((w) => w.id === id ? { ...w, isPinned } : w),
				})),
		}
	})

	return store
})()

// ============================================================================
// Hooks
// ============================================================================

export function useOutletKey() {
	const ctx = React.useContext(DraggableWindowOutletContext)
	return ctx?.outletKey ?? DEFAULT_OUTLET_KEY
}

export function useOutletBaseZIndex() {
	const ctx = React.useContext(DraggableWindowOutletContext)
	const element = ctx?.getElement?.()
	if (!element) return 0
	const parsed = parseInt(getComputedStyle(element).zIndex)
	return isNaN(parsed) ? 0 : parsed + 1
}

export function buildUseOpenWindow<TProps>(id: string) {
	return (props: TProps) => {
		const store = Zus.useStore(DraggableWindowStore)
		const outletKey = useOutletKey()
		return (anchor?: HTMLElement | null) => store.openWindow(id, props, anchor, outletKey)
	}
}

export function useCloseWindow() {
	return Zus.useStore(DraggableWindowStore, (s) => s.closeWindow)
}

export function useWindowDefinitions() {
	return Zus.useStore(DraggableWindowStore, (s) => s.definitions)
}

export function useOpenWindows(): WindowState[] {
	return Zus.useStore(DraggableWindowStore, (s) => s.windows)
}

function findLoaderEntry(loaderCache: Lifecycle.LoaderCacheEntry<WindowLoaderConfig>[], windowId: string) {
	return loaderCache.find((e) => e.key?.windowId === windowId)
}

/**
 * Hook to access loader data for a specific window.
 * Returns undefined if the window is not open or data hasn't loaded yet.
 */
export function useWindowLoaderData<TData>(windowId: string): TData | undefined {
	return Zus.useStore(DraggableWindowStore, (s) => {
		const entry = findLoaderEntry(s.loaderCache, windowId)
		return entry?.data as TData | undefined
	})
}

/**
 * Hook to check if a window's loader is currently loading.
 */
export function useWindowLoading(windowId: string): boolean {
	return Zus.useStore(DraggableWindowStore, (s) => {
		const entry = findLoaderEntry(s.loaderCache, windowId)
		return !!entry && entry.active && !entry.data
	})
}

/**
 * Hook to access the full loader cache entry for a window.
 */
export function useWindowLoaderEntry<TProps = any, TData = any>(
	windowId: string,
): WindowLoaderCacheEntry<TProps, TData> | undefined {
	return Zus.useStore(DraggableWindowStore, (s) => {
		return findLoaderEntry(s.loaderCache, windowId) as WindowLoaderCacheEntry<TProps, TData> | undefined
	})
}
