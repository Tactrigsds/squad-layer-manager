import * as Obj from '@/lib/object'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import * as ReactRx from '@react-rxjs/core'
import { StateObservable } from '@rx-state/core'
import { derive } from 'derive-zustand'
import * as React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { StoreApi, StoreMutatorIdentifier, StoreMutators, useStore } from 'zustand'
import { toStream } from 'zustand-rx'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { distinctDeepEquals } from './async'
import { useDeepEqualsMemo, useStableReferenceDeepEquals } from './react'

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

export function useCombinedStoresDeep<States extends unknown[], Selector extends (states: States) => any>(
	stores: StoresTuple<States>,
	selector: Selector,
	opts: { selectorDeps: unknown[] },
) {
	const [values, setValues] = React.useState(() => stores.map(s => s.getState()) as States)

	const updateValues = React.useCallback(() => {
		setValues(stores.map(s => s.getState()) as States)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...stores])

	React.useEffect(() => {
		const subscriptions = stores.map(s => s.subscribe(updateValues))
		return () => subscriptions.forEach(unsub => unsub())
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...stores])

	return React.useMemo(() => {
		return selector(values)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...opts.selectorDeps, values]) as ReturnType<Selector>
}

export function storeFromObservable<T>(o: StateObservable<T>, initialValue: T, opts: { sub: Rx.Subscription }) {
	return Zus.createStore<T>((set) => {
		opts.sub.add(o.subscribe({ next: s => set(s) }))
		return initialValue
	})
}

type StoresTuple<States extends unknown[]> = [...{ [s in keyof States]: StoreApi<States[s]> }]
