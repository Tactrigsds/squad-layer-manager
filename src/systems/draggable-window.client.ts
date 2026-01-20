import type * as React from 'react'
import * as Zus from 'zustand'

// ============================================================================
// Types
// ============================================================================

export type InitialPosition = 'above' | 'below' | 'left' | 'right' | 'viewport-center'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WindowDefinition<TProps = any> {
	type: string
	component: React.ComponentType<TProps>
	getId: (props: TProps) => string
	initialPosition?: InitialPosition
	defaultPinned?: boolean
	offset?: number
	collisionPadding?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface OpenWindowState<TProps = any> {
	id: string
	props: TProps
	anchorRect: DOMRect | null // captured at open time, null = viewport-center
	position: { x: number; y: number } | null // null until calculated
	zIndex: number
	isPinned: boolean
}

interface DraggableWindowStore {
	definitions: WindowDefinition[]
	openWindows: OpenWindowState[]
	zIndexCounter: number

	// Actions
	registerDefinition: <TProps>(def: WindowDefinition<TProps>) => void
	unregisterDefinition: (id: string) => void
	openWindow: <TProps>(id: string, props: TProps, anchor?: HTMLElement | null) => void
	closeWindow: (id: string) => void
	bringToFront: (id: string) => void
	updatePosition: (id: string, position: { x: number; y: number }) => void
	setIsPinned: (id: string, pinned: boolean) => void
}

const BASE_Z_INDEX = 100

export const DraggableWindowStore = Zus.createStore<DraggableWindowStore>((set, get) => ({
	definitions: [],
	openWindows: [],
	zIndexCounter: BASE_Z_INDEX,

	registerDefinition: (def) =>
		set((s) => {
			if (s.definitions.some((d) => d.type === def.type)) {
				throw new Error(`DraggableWindow: Definition with type "${def.type}" is already registered`)
			}
			return {
				definitions: [...s.definitions, def],
			}
		}),

	unregisterDefinition: (id) =>
		set((s) => ({
			definitions: s.definitions.filter((d) => d.type !== id),
		})),

	openWindow: (id, props, anchor) => {
		const { definitions, openWindows, zIndexCounter } = get()
		const def = definitions.find((d) => d.type === id)
		if (!def) {
			console.warn(`DraggableWindow: No definition found for id "${id}"`)
			return
		}

		// If already open, just bring to front
		if (openWindows.some((w) => w.id === id)) {
			get().bringToFront(id)
			return
		}

		const anchorRect = anchor?.getBoundingClientRect() ?? null

		set({
			openWindows: [
				...openWindows,
				{
					id,
					props,
					anchorRect,
					position: null,
					zIndex: zIndexCounter + 1,
					isPinned: def.defaultPinned ?? false,
				},
			],
			zIndexCounter: zIndexCounter + 1,
		})
	},

	closeWindow: (id) =>
		set((s) => ({
			openWindows: s.openWindows.filter((w) => w.id !== id),
		})),

	bringToFront: (id) =>
		set((s) => ({
			openWindows: s.openWindows.map((w) => (w.id === id ? { ...w, zIndex: s.zIndexCounter + 1 } : w)),
			zIndexCounter: s.zIndexCounter + 1,
		})),

	updatePosition: (id, position) =>
		set((s) => ({
			openWindows: s.openWindows.map((w) => (w.id === id ? { ...w, position } : w)),
		})),

	setIsPinned: (id, isPinned) =>
		set((s) => ({
			openWindows: s.openWindows.map((w) => (w.id === id ? { ...w, isPinned } : w)),
		})),
}))

// ============================================================================
// Hooks
// ============================================================================

export function buildUseOpenWindow<TProps>(id: string) {
	return (props: TProps, anchor?: HTMLElement) => Zus.useStore(DraggableWindowStore, (s) => () => s.openWindow(id, props, anchor))
}

export function useCloseWindow() {
	return Zus.useStore(DraggableWindowStore, (s) => s.closeWindow)
}

export function useWindowDefinitions() {
	return Zus.useStore(DraggableWindowStore, (s) => s.definitions)
}

export function useOpenWindows() {
	return Zus.useStore(DraggableWindowStore, (s) => s.openWindows)
}
