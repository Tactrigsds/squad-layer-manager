import * as Zus from 'zustand'

export type Store = {
	showSwaps: boolean
	setShowSwaps: (showSwaps: boolean) => void
}

export const Store = Zus.createStore<Store>((set) => ({
	showSwaps: false,
	setShowSwaps: (showSwaps) => set({ showSwaps }),
}))
