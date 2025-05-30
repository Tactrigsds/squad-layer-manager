import deepEqual from 'fast-deep-equal'
import { StoreApi, StoreMutatorIdentifier, StoreMutators } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'

// ripped from zustand types
type Get<T, K, F> = K extends keyof T ? T[K] : F
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms] ? S
	: Ms extends [] ? S
	: Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
	: never

export type Setter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'setState', never>
export type Getter<T, Mis extends [StoreMutatorIdentifier, unknown][] = []> = Get<Mutate<StoreApi<T>, Mis>, 'getState', never>

export function useStoreDeep<S, O>(store: StoreApi<S>, selector: (s: S) => O) {
	return useStoreWithEqualityFn(store, selector, deepEqual)
}
