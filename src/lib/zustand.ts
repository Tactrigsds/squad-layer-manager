import * as Obj from '@/lib/object'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import * as ReactRx from '@react-rxjs/core'
import { derive } from 'derive-zustand'
import deepEqual from 'fast-deep-equal'
import * as React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { StoreApi, StoreMutatorIdentifier, StoreMutators, useStore } from 'zustand'
import { toStream } from 'zustand-rx'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { distinctDeepEquals } from './async'

// ripped from zustand types
type Get<T, K, F> = K extends keyof T ? T[K] : F
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms] ? S
	: Ms extends [] ? S
	: Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
	: never

export type Setter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'setState', never>
export type Getter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'getState', never>

export function useStoreDeep<S, O>(store: StoreApi<S>, selector: (s: S) => O, opts?: { dependencies?: unknown[] }) {
	if (opts?.dependencies) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		selector = React.useCallback(selector, opts.dependencies)
	}

	return useStoreWithEqualityFn(store, selector, deepEqual)
}

export function useStoreDeepMultiple<States extends unknown[], Selector extends (states: States) => any>(
	_stores: StoresTuple<States>,
	selector: Selector,
	// when pureSelector is true, the selector is assumed not not have any closures
	opts: { selectorDeps: [] },
) {
	const subRef = React.useRef<Rx.Subscription | null>()
	// eslint-disable-next-line react-hooks/exhaustive-deps
	selector = React.useCallback(selector, opts.selectorDeps)
	const combined = React.useMemo(() => {
		subRef.current?.unsubscribe()
		subRef.current = new Rx.Subscription()
		const streams = _stores.map(storeOr$ => {
			if (Rx.isObservable(storeOr$)) {
				return storeOr$
			}
			return toStream(storeOr$)
		})
		const combined = ReactRx.state(
			Rx.combineLatest(streams).pipe(
				Rx.map(states => selector(states as unknown as States)),
				distinctDeepEquals(),
			) as ReactRx.StateObservable<ReturnType<Selector>>,
		)
		return storeFromStateObservable(combined, { sub: subRef.current })

		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [..._stores, selector])
	return useStore(combined)
}

export function storeFromStateObservable<T>(o: ReactRx.StateObservable<T>, opts: { sub: Rx.Subscription }) {
	return Zus.createStore((set) => {
		opts.sub.add(o.subscribe(s => set(s)))
		return o.getValue()
	})
}

type StoresTuple<States extends unknown[]> = [...{ [s in keyof States]: StoreApi<States[s]> | ReactRx.StateObservable<States[s]> }]
