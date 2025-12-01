import * as Obj from '@/lib/object'
import type { StateObservable } from '@rx-state/core'
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
