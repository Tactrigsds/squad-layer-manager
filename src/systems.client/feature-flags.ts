import { isNullOrUndef } from '@/lib/type-guards'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import * as Zus from 'zustand'
import { persist } from 'zustand/middleware'

const FEATURE_FLAGS = {
	reactQueryDevtools: false,
	trpcLogs: false,
	displayWsClientId: false,
	loadConsole: false,
}

interface FeatureFlagsState {
	flags: typeof FEATURE_FLAGS
	setFeatureFlag: (flag: keyof typeof FEATURE_FLAGS, value: boolean) => void
}

export const Store = Zus.create<FeatureFlagsState>()(
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
	return Store.getState().flags[key]
}

// @ts-expect-error expose to console
window.featureFlags = {
	list() {
		return Store.getState().flags
	},
	set(flag: string, value: boolean) {
		const store = Store.getState()
		if (isNullOrUndef(FEATURE_FLAGS[flag as keyof typeof FEATURE_FLAGS])) {
			return `Feature flag ${flag} does not exist`
		}
		store.setFeatureFlag(flag as keyof typeof FEATURE_FLAGS, value)
		return 'ok'
	},
}

export function useFeatureFlags() {
	return Store((state) => state.flags)
}

export { Store as featureFlagsStore }
