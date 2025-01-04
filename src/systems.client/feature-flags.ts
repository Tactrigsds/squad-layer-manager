import { atom, getDefaultStore, useAtomValue } from 'jotai'
import { withImmer } from 'jotai-immer'

function atomWithLocalStorage<T>(key: string, initialValue: T) {
	const getInitialValue = () => {
		const item = localStorage.getItem(key)
		if (item !== null) {
			return JSON.parse(item) as T
		}
		return initialValue
	}
	const baseAtom = atom(getInitialValue())
	const derivedAtom = atom(
		(get) => get(baseAtom),
		(get, set, update) => {
			const nextValue = typeof update === 'function' ? update(get(baseAtom)) : update
			set(baseAtom, nextValue)
			localStorage.setItem(key, JSON.stringify(nextValue))
		}
	)
	return derivedAtom
}

const FEATURE_FLAGS = {
	historyFilters: false,
}

export const featureFlagsAtom = atomWithLocalStorage('featureFlags', FEATURE_FLAGS)

//@ts-expect-error - this is a hack to expose the feature flags to the window object so we can set them in the console
window.setFeatureFlag = (flag, value) => {
	const store = getDefaultStore()
	//@ts-expect-error whew
	store.set(withImmer(featureFlagsAtom), (flags) => (flags[flag] = value))
	console.log('Feature flag set:', flag, value)
}

export function useFeatureFlags() {
	return useAtomValue(featureFlagsAtom, { store: getDefaultStore() })
}
