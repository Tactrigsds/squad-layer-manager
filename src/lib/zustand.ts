import * as Obj from '@/lib/object'
import type { StateObservable } from '@rx-state/core'
import { useQueries } from '@tanstack/react-query'
import type { UseQueryOptions } from '@tanstack/react-query'
import { derive } from 'derive-zustand'
import * as React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import type { StoreApi, StoreMutatorIdentifier, StoreMutators } from 'zustand'
import { useShallow as useShallowImported } from 'zustand/react/shallow'
import { useStoreWithEqualityFn } from 'zustand/traditional'

// ripped from zustand types
type Get<T, K, F> = K extends keyof T ? T[K] : F
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms] ? S
	: Ms extends [] ? S
	: Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
	: never

export type Setter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'setState', never>
export type Getter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'getState', never>

export function useStoreDeep<S, O>(store: StoreApi<S>, selector: (s: S) => O, opts?: { dependencies?: unknown[] }) {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	selector = React.useCallback(selector, opts?.dependencies ?? [])

	return useStoreWithEqualityFn(store, selector, Obj.deepEqual)
}

export function useCombinedStores<States extends unknown[], Selector extends (states: States) => any>(
	stores: StoresTuple<States>,
	selector: Selector,
) {
	const [value, setValue] = React.useState(() => selector(stores.map(s => s.getState()) as States))

	React.useEffect(() => {
		const updateValues = () => {
			setValue(selector(stores.map(s => s.getState()) as States))
		}
		const subscriptions = stores.map(s => s.subscribe(updateValues))
		return () => subscriptions.forEach(unsub => unsub())
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...stores, setValue, selector])
	return value
}

export function storeFromObservable<T>(o: StateObservable<T>, initialValue: T, opts: { sub: Rx.Subscription }) {
	return Zus.createStore<T>((set) => {
		opts.sub.add(o.subscribe({ next: s => set(s) }))
		return initialValue
	})
}

type StoresTuple<States extends unknown[]> = [...{ [s in keyof States]: StoreApi<States[s]> }]

type AnySource<T> = StoreApi<T> | StateObservable<T>
type QuerySource<T> = UseQueryOptions<T, any, T, any>
type AnyInput<T> = AnySource<T> | QuerySource<T>
type InputState<S> = S extends AnySource<infer T> ? T : S extends QuerySource<infer T> ? T | undefined : never
type InputStates<Inputs extends AnyInput<any>[]> = { [K in keyof Inputs]: InputState<Inputs[K]> }

function isQuerySource(s: unknown): s is QuerySource<any> {
	return typeof s === 'object' && s !== null && 'queryKey' in s && !('getState' in s) && !('getValue' in s)
}

function isObservable(s: AnySource<any>): s is StateObservable<any> {
	return 'getValue' in s
}

function getSourceState(s: AnySource<any>): any {
	return isObservable(s) ? s.getValue() : s.getState()
}

function subscribeSource(s: AnySource<any>, update: () => void): () => void {
	if (isObservable(s)) {
		const sub = s.subscribe({ next: update })
		return () => sub.unsubscribe()
	}
	return s.subscribe(update)
}

export function useStore<S>(store: AnyInput<S>): InputState<typeof store>
export function useStore<Inputs extends AnyInput<any>[], R>(
	...args: [...Inputs, (...states: InputStates<Inputs>) => R]
): R
export function useStore<Inputs extends AnyInput<any>[]>(...inputs: Inputs): InputStates<Inputs>
export function useStore(...args: (AnyInput<any> | ((...states: any[]) => any))[]): any {
	const hasSelector = typeof args[args.length - 1] === 'function'
	const allInputs = (hasSelector ? args.slice(0, -1) : args) as AnyInput<any>[]
	const selector = hasSelector ? args[args.length - 1] as (...states: any[]) => any : undefined

	const regularSources = allInputs.filter((s): s is AnySource<any> => !isQuerySource(s))
	const querySources = allInputs.filter(isQuerySource)

	const queryResults = useQueries({ queries: querySources })

	const compute = () => {
		let qIdx = 0
		const states = allInputs.map(input =>
			isQuerySource(input) ? queryResults[qIdx++]?.data : getSourceState(input as AnySource<any>)
		)
		return selector ? selector(...states) : states.length === 1 ? states[0] : states
	}

	const [value, setValue] = React.useState(compute)

	React.useEffect(() => {
		const update = () => setValue(compute())
		const unsubs = regularSources.map(s => subscribeSource(s, update))
		return () => unsubs.forEach(unsub => unsub())
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...regularSources, selector, ...queryResults.map(r => r.data)])

	return value
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

export function useDeepNoFns<S, U>(selector: (state: S) => U): (state: S) => U {
	const prev = React.useRef<U | undefined>(void 0)
	return (state: S) => {
		const next = selector(state)
		return Obj.deepEqual(prev.current, next) ? (prev.current as U) : prev.current = next
	}
}

export function toObservable<S>(store: StoreApi<S>): Rx.Observable<[S, S]> {
	return new Rx.Observable(subscriber => {
		const unsub = store.subscribe((state, prev) => {
			subscriber.next([state, prev])
		})

		return () => unsub()
	})
}

export const deriveStores = derive
