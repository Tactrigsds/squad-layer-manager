import * as Zus from '@/lib/zustand'

export type Tab = 'details' | 'scores'

type Store = {
	activeTab: Tab
}

export const Store = Zus.createStore<Store>()(() => ({
	activeTab: 'details',
}))

export namespace Actions {
	export function setActiveTab(tab: Tab) {
		Store.setState({ activeTab: tab })
	}
}
