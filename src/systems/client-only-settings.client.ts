import * as Zus from 'zustand'
import * as ZusMiddle from 'zustand/middleware'

export type ChartTab = 'population' | 'kd' | 'wd'
export type ChartTimeInterval = 1 | 5 | 10

export type ClientOnlySettingsStore = {
	displayTeamsNormalized: boolean
	setDisplayTeamsNormalized: (value: boolean) => void
	chartTab: ChartTab
	setChartTab: (value: ChartTab) => void
	chartTimeInterval: ChartTimeInterval
	setChartTimeInterval: (value: ChartTimeInterval) => void
}

export const Store = Zus.createStore<ClientOnlySettingsStore>()(ZusMiddle.persist((set, _get) => ({
	displayTeamsNormalized: true,
	setDisplayTeamsNormalized: (value: boolean) => set({ displayTeamsNormalized: value }),
	chartTab: 'population',
	setChartTab: (value: ChartTab) => set({ chartTab: value }),
	chartTimeInterval: 5,
	setChartTimeInterval: (value: ChartTimeInterval) => set({ chartTimeInterval: value }),
}), {
	name: 'settings:v1',
	storage: ZusMiddle.createJSONStorage(() => localStorage),
}))

// we're just hardcoding this to true for now
Store.getState().setDisplayTeamsNormalized(true)

// legacy alias used by components that imported this as GlobalSettingsStore
export { Store as GlobalSettingsStore }
