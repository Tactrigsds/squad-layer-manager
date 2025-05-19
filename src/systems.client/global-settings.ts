import * as Zus from 'zustand'
import * as ZusMiddle from 'zustand/middleware'

export type GlobalSettingsStore = {
	displayTeamsNormalized: boolean
	setDisplayTeamsNormalized: (value: boolean) => void
}

export const GlobalSettingsStore = Zus.createStore<GlobalSettingsStore>()(ZusMiddle.persist((set, _get) => ({
	displayTeamsNormalized: false,
	setDisplayTeamsNormalized: (value: boolean) => set({ displayTeamsNormalized: value }),
}), {
	name: 'settings:v1',
	storage: ZusMiddle.createJSONStorage(() => localStorage),
}))
