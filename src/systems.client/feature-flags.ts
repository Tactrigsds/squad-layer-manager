import { isNullOrUndef } from '@/lib/type-guards'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import * as Zus from 'zustand'
import { persist } from 'zustand/middleware'

const FEATURE_FLAGS = {
	reactQueryDevtools: false,
	trpcLogs: false,
}

interface FeatureFlagsState {
	flags: typeof FEATURE_FLAGS
	setFeatureFlag: (flag: keyof typeof FEATURE_FLAGS, value: boolean) => void
}

const featureFlagsStore = Zus.create<FeatureFlagsState>()(
	persist(
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
	return featureFlagsStore.getState().flags[key]
}

// @ts-expect-error expose to console
window.featureFlags = {
	list() {
		return featureFlagsStore.getState().flags
	},
	set(flag: string, value: boolean) {
		const store = featureFlagsStore.getState()
		if (isNullOrUndef(FEATURE_FLAGS[flag as keyof typeof FEATURE_FLAGS])) {
			return `Feature flag ${flag} does not exist`
		}
		store.setFeatureFlag(flag as keyof typeof FEATURE_FLAGS, value)
		return 'ok'
	},
}

export function useFeatureFlags() {
	return featureFlagsStore((state) => state.flags)
}

export { featureFlagsStore }
