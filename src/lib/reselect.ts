import { createSelectorCreator, weakMapMemoize } from 'reselect'

import * as Obj from '@/lib/object-utils'

// Module-level memoized selectors for zustand stores (see "Sel and Actions" in docs/architecture.md).
//
// Selectors built with these helpers return identity-stable results, so components can
// subscribe with a bare `Zus.useStore(store, Sel.foo)` -- no useShallow/useDeep wrapper --
// and only re-render when the selected data actually changes.
//
// Keep them module-level. `Zus.useStore` caches its snapshot on the selector's identity as well as the states, so
// a selector defined inline in a component body is a new function every render; if it also builds a fresh array or
// object, every render sees a new snapshot and useSyncExternalStore spins.
//
// For parameterized selectors, memoize the factory itself so every call site shares one
// selector instance (and one cache) per parameter:
//
//   export const itemState = memoizeFactory((itemId: string) =>
//     createDeepSelector([layerList, mutations], (list, muts) => ...))

// re-export; reselect v5 defaults both memoize and argsMemoize to weakMapMemoize
export { createSelector } from 'reselect'

// like createSelector, but when recomputing produces a result deeply equal to the previous
// one, the previous reference is returned. use for selectors that build fresh objects/arrays,
// in place of wrapping every call site in Zus.useDeep
export const createDeepSelector = createSelectorCreator({
	memoize: weakMapMemoize,
	memoizeOptions: { resultEqualityCheck: Obj.deepEqual },
	argsMemoize: weakMapMemoize,
})

// memoizes a selector factory per parameter. note: cache entries for primitive params are
// held strongly for the life of the app -- fine for ids, don't key on unbounded user input
export const memoizeFactory = weakMapMemoize
