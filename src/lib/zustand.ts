import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object'
import type { StateObservable } from '@react-rxjs/core'
import { useQueries } from '@tanstack/react-query'
import type { UseQueryOptions } from '@tanstack/react-query'
import { derive } from 'derive-zustand'
import * as React from 'react'
import * as Rx from 'rxjs'

import type { StoreApi, StoreMutatorIdentifier, StoreMutators } from 'zustand'
import { useShallow as useShallowImported } from 'zustand/react/shallow'

// ripped from zustand types
type Get<T, K, F> = K extends keyof T ? T[K] : F
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms] ? S
	: Ms extends [] ? S
	: Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
	: never

export type Setter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'setState', never>
export type Getter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'getState', never>

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== 'object' || v === null) return false
	const proto = Object.getPrototypeOf(v)
	return proto === Object.prototype || proto === null
}

// returns a full setState-style setter scoped to property K of T -- supports value, partial-merge, updater fn, and the replace flag
export function toPartialSetter<T, K extends keyof T>(store: StoreApi<T>, key: K): Setter<T[K]>
export function toPartialSetter<T, K extends keyof T>(set: Setter<T>, key: K): Setter<T[K]>
export function toPartialSetter(a: StoreApi<any> | Setter<any>, key: any): any {
	const set: Setter<any> = typeof a === 'function' ? a : a.setState
	return ((partial: any, replace?: boolean) => {
		set((state: any) => {
			const prev = state[key]
			const resolved = typeof partial === 'function' ? partial(prev) : partial
			// merging only makes sense for plain objects -- spreading arrays/Maps/class instances would mangle them
			const next = !replace && isPlainObject(prev) && isPlainObject(resolved)
				? { ...prev, ...resolved }
				: resolved
			return { [key]: next }
		})
	})
}

// returns a getter scoped to property K of T
export function toPartialGetter<T extends NonNullable<object>, K extends keyof T>(store: AnyStore<T>, key: K): Getter<T[K]>
export function toPartialGetter<T, K extends keyof T>(get: Getter<T>, key: K): Getter<T[K]>
export function toPartialGetter(source: AnyStore<any> | Getter<any>, key: any): any {
	if (typeof source === 'function') return () => source()[key]
	return () => resolveReadStore(source).getState()[key]
}

export type AnyStore<T extends NonNullable<object>> = StoreApi<T> | FRM.InstanceKeyOfState<T>
export type QuerySource<T> = UseQueryOptions<T, any, T, any>
export type AnyInput<T extends NonNullable<object>> = AnyStore<T> | QuerySource<T> | StateObservable<T>
// nullish inputs are tolerated and read as `undefined` -- lets callers pass conditionally-available keys
type MaybeInput = AnyInput<any> | null | undefined
// synchronously readable + subscribable sources, i.e. what frame keys resolve to
type SyncSource<T> = StoreApi<T> | StateObservable<T>
type ResolvedInput<T> = SyncSource<T> | QuerySource<T>
type InputState<S> = S extends null | undefined ? undefined
	: S extends Readonly<{ _: infer FT extends FRM.FrameTypes }> ? FT['state']
	: S extends StateObservable<infer T> ? T
	: S extends StoreApi<infer T> ? T
	: S extends QuerySource<infer T> ? T | undefined
	: never
type InputStates<Inputs extends MaybeInput[]> = { [K in keyof Inputs]: InputState<Inputs[K]> }

function isQuerySource(s: unknown): s is QuerySource<any> {
	return typeof s === 'object' && s !== null && 'queryKey' in s && !('getState' in s) && !('getValue' in s)
}

function isFrameKey(s: unknown): s is FRM.InstanceKeyOfState<any> {
	return typeof s === 'object' && s !== null && 'frameId' in s && typeof (s as { frameId: unknown }).frameId === 'symbol'
}

// injected by FRM.createFrameHelpers -- frame.ts imports this module at runtime, so we can't import the frame manager here
type FrameStores = { store: StoreApi<any>; update$: Rx.Observable<any> }
let resolveFrameKeyStores: ((key: FRM.InstanceKeyOfState<any>) => FrameStores | undefined) | undefined
export function registerFrameKeyResolver(resolve: (key: FRM.InstanceKeyOfState<any>) => FrameStores | undefined) {
	resolveFrameKeyStores = resolve
}

function resolveFrameStores(key: FRM.InstanceKeyOfState<any>): FrameStores {
	const stores = resolveFrameKeyStores?.(key)
	if (!stores) throw new Error(`Frame instance not found for key ${String(key.frameId)}`)
	return stores
}

export function resolveReadStore<T extends NonNullable<object>>(store: AnyStore<T>): StoreApi<T> {
	return isFrameKey(store) ? resolveFrameStores(store).store : store
}

function resolveInput(input: MaybeInput): ResolvedInput<any> | null {
	if (input == null) return null
	if (isFrameKey(input)) return resolveFrameStores(input).store
	return input
}

function isObservable(s: SyncSource<any>): s is StateObservable<any> {
	return 'getValue' in s
}

function getSourceState(s: SyncSource<any> | null): any {
	if (s == null) return undefined
	return isObservable(s) ? s.getValue() : s.getState()
}

function subscribe(s: AnyStore<any> | null, update: () => void): () => void {
	if (s == null) return () => {}
	if (isFrameKey(s)) {
		const store = resolveFrameStores(s)
		const sub = store.update$.subscribe(update)
		return () => sub.unsubscribe()
	}
	if (isObservable(s)) {
		const sub = s.pipe(Rx.skip(1)).subscribe({ next: update })
		return () => sub.unsubscribe()
	}
	return s.subscribe(update)
}

export function getState<S extends AnyStore<any> | null | undefined>(source: S): InputState<S>
export function getState(source: AnyStore<any> | null | undefined): any {
	if (source == null) return undefined
	return resolveReadStore(source).getState()
}

export function useStore<I extends MaybeInput>(store: I): InputState<I>
export function useStore<Inputs extends MaybeInput[], R>(
	...args: [...Inputs, (...states: InputStates<Inputs>) => R]
): R
export function useStore<Inputs extends MaybeInput[]>(...inputs: Inputs): InputStates<Inputs>
export function useStore(...args: (MaybeInput | ((...states: any[]) => any))[]): any {
	const hasSelector = typeof args[args.length - 1] === 'function'
	// nullish inputs stay in the array as placeholders so hook/effect-dep counts are stable across renders
	const allInputs = ((hasSelector ? args.slice(0, -1) : args) as MaybeInput[]).map(resolveInput)
	const selector = hasSelector ? args[args.length - 1] as (...states: any[]) => any : undefined

	const regularSources = allInputs.filter((s): s is SyncSource<any> | null => !isQuerySource(s))
	const querySources = allInputs.filter(isQuerySource)

	const queryResults = useQueries({ queries: querySources })

	// when there's no selector and multiple inputs we pack states into a fresh array each compute,
	// so equality checks must compare element-wise to avoid spurious re-renders
	const packed = !selector && allInputs.length > 1
	const compute = () => {
		let qIdx = 0
		const states = allInputs.map(input =>
			isQuerySource(input) ? queryResults[qIdx++]?.data : getSourceState(input as SyncSource<any> | null)
		)
		return selector ? selector(...states) : states.length === 1 ? states[0] : states
	}
	// latest compute lives in a ref so subscriptions see fresh selector/query data without
	// re-subscribing when an inline selector changes identity every render
	const computeRef = React.useRef(compute)
	computeRef.current = compute

	const [value, setValue] = React.useState(compute)

	React.useEffect(() => {
		const update = () =>
			setValue((prev: any) => {
				const next = computeRef.current()
				if (Object.is(prev, next)) return prev
				if (packed && Array.isArray(prev) && prev.length === next.length && prev.every((v: any, i: number) => Object.is(v, next[i]))) {
					return prev
				}
				return next
			})
		const unsubs = regularSources.map(s => subscribe(s as any, update))
		// sync once: catches emissions between render and subscription, and query data changes
		update()
		return () => unsubs.forEach(unsub => unsub())
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...regularSources, ...queryResults.map(r => r.data)])

	return value
}

// a live StoreApi view over the whole source store -- like toPartialStore but unscoped
export function resolveStore<T extends NonNullable<object>>(store: AnyStore<T>): StoreApi<T> {
	if (!isFrameKey(store)) return store
	return {
		getState: () => resolveReadStore(store).getState(),
		getInitialState: () => {
			const source = resolveReadStore(store)
			// derived stores may not implement getInitialState
			return (source.getInitialState ?? source.getState)()
		},
		setState: (partial: any, replace?: any) => resolveReadStore(store).setState(partial, replace),
		subscribe: (listener) => resolveReadStore(store).subscribe(listener),
	}
}

// a live StoreApi view over property K of the source store. frame keys are resolved lazily on each
// access so the view stays valid if the frame instance is recreated. only notifies subscribers when the
// slice itself changes (Object.is)
export function toPartialStore<T extends NonNullable<object>, K extends keyof T>(store: AnyStore<T>, key: K): StoreApi<T[K]> {
	const set: Setter<T> = (partial: any, replace?: any) => resolveReadStore(store).setState(partial, replace)
	const setState = toPartialSetter(set, key)

	return {
		getState: () => resolveReadStore(store).getState()[key],
		getInitialState: () => {
			const source = resolveReadStore(store)
			// derived stores may not implement getInitialState
			return (source.getInitialState ?? source.getState)()[key]
		},
		setState,
		subscribe: (listener) =>
			resolveReadStore(store).subscribe((state, prev) => {
				if (!Object.is(state[key], prev[key])) listener(state[key], prev[key])
			}),
	}
}

export function usePartialStore<T extends NonNullable<object>, K extends keyof T>(store: AnyStore<T>, key: K): StoreApi<T[K]> {
	return React.useMemo(() => toPartialStore(store, key), [store, key])
}

export type UnsubscribeFn = () => void
export type SubArg = UnsubscribeFn | Rx.Subscription

export function toRxSub(unsub: UnsubscribeFn) {
	return Rx.NEVER.pipe(Rx.tap({ unsubscribe: unsub })).subscribe()
}

export const useShallow = useShallowImported
export function useDeep<S, U>(selector: (state: S) => U): (state: S) => U {
	const prev = React.useRef<U | undefined>(void 0)
	return React.useCallback((state: S) => {
		const next = selector(state)
		return Obj.deepEqual(prev.current, next) ? (prev.current as U) : prev.current = next
	}, [selector])
}

export function toObservable<S extends NonNullable<object>, EmitCurrent extends boolean | undefined>(
	store: AnyStore<S>,
	emitCurrent?: EmitCurrent,
): Rx.Observable<[S, EmitCurrent extends true ? S | null : S]> {
	return new Rx.Observable(subscriber => {
		// prev starts at the state as of subscription so the first update carries a real previous value
		let prev: S = getState(store)
		if (emitCurrent) subscriber.next([prev, null as any])
		const unsub = subscribe(store, () => {
			const state = getState(store)
			const temp = prev
			prev = state
			subscriber.next([state, temp])
		})

		return () => unsub()
	})
}

export const deriveStores = derive
