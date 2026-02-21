import * as Zus from 'zustand'
import * as ZusMiddle from 'zustand/middleware'

export type ChartTab = 'population' | 'kd' | 'wd'
export type ChartTimeInterval = 1 | 5 | 10

export type GlobalSettingsStore = {
	displayTeamsNormalized: boolean
	setDisplayTeamsNormalized: (value: boolean) => void
	chartTab: ChartTab
	setChartTab: (value: ChartTab) => void
	chartTimeInterval: ChartTimeInterval
	setChartTimeInterval: (value: ChartTimeInterval) => void
}

export const GlobalSettingsStore = Zus.createStore<GlobalSettingsStore>()(ZusMiddle.persist((set, _get) => ({
	displayTeamsNormalized: false,
	setDisplayTeamsNormalized: (value: boolean) => set({ displayTeamsNormalized: value }),
	chartTab: 'population',
	setChartTab: (value: ChartTab) => set({ chartTab: value }),
	chartTimeInterval: 5,
	setChartTimeInterval: (value: ChartTimeInterval) => set({ chartTimeInterval: value }),
}), {
	name: 'settings:v1',
	storage: ZusMiddle.createJSONStorage(() => localStorage),
}))
