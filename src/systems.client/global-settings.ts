import * as Zus from 'zustand'
import * as ZusMiddle from 'zustand/middleware'

export type GlobalSettingsStore = {
	displayLayersNormalized: boolean
	setDisplayLayersNormalized: (value: boolean) => void
}

export const GlobalSettingsStore = Zus.createStore<GlobalSettingsStore>()(ZusMiddle.persist((set, _get) => ({
	displayLayersNormalized: false,
	setDisplayLayersNormalized: (value: boolean) => set({ displayLayersNormalized: value }),
}), {
	name: 'settings:v1',
	storage: ZusMiddle.createJSONStorage(() => localStorage),
}))
