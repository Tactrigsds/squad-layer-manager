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

// @ts-expect-error expose to console
window.featureFlags = {}

// Define getters and setters for each feature flag
Object.keys(FEATURE_FLAGS).forEach((flag) => {
	// @ts-expect-error idgaf
	Object.defineProperty(window.featureFlags, flag, {
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

export function useFeatureFlags() {
	return Store((state) => state.flags)
}

export { Store as featureFlagsStore }
