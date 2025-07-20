import * as Obj from '@/lib/object'
import * as ReactHelpers from '@/lib/react'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import * as ReactRx from '@react-rxjs/core'
import { derive } from 'derive-zustand'
import deepEqual from 'fast-deep-equal'
import * as React from 'react'
import * as Rx from 'rxjs'
import { StoreApi, StoreMutatorIdentifier, StoreMutators, useStore } from 'zustand'
import * as ZusRx from 'zustand-rx'
import { useStoreWithEqualityFn } from 'zustand/traditional'

// ripped from zustand types
type Get<T, K, F> = K extends keyof T ? T[K] : F
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms] ? S
	: Ms extends [] ? S
	: Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
	: never

export type Setter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'setState', never>
export type Getter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'getState', never>

export function useStoreDeep<S, O>(store: StoreApi<S>, selector: (s: S) => O, opts?: { pureSelector?: boolean }) {
	const prevPureSelector = React.useRef<boolean | undefined>(opts?.pureSelector)
	if (prevPureSelector.current !== opts?.pureSelector) {
		throw new Error('useStoreDeepMultiple: pureSelector cannot be changed after initial render')
	}
	if (opts?.pureSelector) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		selector = React.useCallback(selector, [])
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
	React.useEffect(() => {
		return () => subRef.current?.unsubscribe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	// eslint-disable-next-line react-hooks/exhaustive-deps
	selector = React.useCallback(selector, opts.selectorDeps)
	const combined = React.useMemo(() => {
		subRef.current?.unsubscribe()
		subRef.current = new Rx.Subscription()
		const stores = _stores.map(storeOr$ => {
			if (!Rx.isObservable(storeOr$)) return storeOr$ as StoreApi<States[number]>
			return ReactRxHelpers.storeFromStateObservable(storeOr$, { sub: subRef.current })
		})
		const memo = Obj.deepMemo()
		return derive<ReturnType<Selector>>(get => {
			const states = stores.map(store => get(store)) as States
			return memo(selector(states))
		})
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [..._stores, selector, subRef.current])
	return useStore(combined)
}

type StoresTuple<States extends unknown[]> = [...{ [s in keyof States]: StoreApi<States[s]> | ReactRx.StateObservable<States[s]> }]
