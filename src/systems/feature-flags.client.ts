import * as Zus from '@/lib/zustand'

const FEATURE_FLAGS = {
	displayWsClientId: false,
	loadConsole: false,
}

interface FeatureFlagsState {
	flags: typeof FEATURE_FLAGS
	setFeatureFlag: (flag: keyof typeof FEATURE_FLAGS, value: boolean) => void
}

export const Store = Zus.create<FeatureFlagsState>()(
	Zus.persist(
		(set) => ({
			flags: FEATURE_FLAGS,
			setFeatureFlag: (flag, value) =>
				set((state) => ({
					flags: {
						...state.flags,
						[flag]: value,
					},
				})),
		}),
		{
			name: 'featureFlags:v1',
			partialize: (state) => ({ flags: state.flags }),
		},
	),
)

export function get(key: keyof typeof FEATURE_FLAGS) {
	return Store.getState().flags[key]
}

const consoleFeatureFlags = {}
Object.keys(FEATURE_FLAGS).forEach((flag) => {
	Object.defineProperty(consoleFeatureFlags, flag, {
		get() {
			return Store.getState().flags[flag as keyof typeof FEATURE_FLAGS]
		},
		set(value: boolean) {
			Store.getState().setFeatureFlag(flag as keyof typeof FEATURE_FLAGS, value)
		},
		enumerable: true,
		configurable: true,
	})
})
;(window as unknown as { featureFlags: object }).featureFlags = consoleFeatureFlags

export function useFeatureFlags() {
	return Store((state) => state.flags)
}

export { Store as featureFlagsStore }
