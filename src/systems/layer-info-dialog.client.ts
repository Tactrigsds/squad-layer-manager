import * as Zus from 'zustand'

export type Tab = 'details' | 'scores'

type Store = {
	activeTab: Tab
	setActiveTab: (tab: Tab) => void
}

export const Store = Zus.createStore<Store>()(
	(set) => ({
		activeTab: 'details',
		setActiveTab: (tab: Tab) => set({ activeTab: tab }),
	}),
)

export function useActiveTab() {
	const store = Zus.useStore(Store)

	return [store.activeTab, store.setActiveTab] as const
}
