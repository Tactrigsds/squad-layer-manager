import * as Zus from 'zustand'
import * as ZusMiddle from 'zustand/middleware'

export type ChartTab = 'population' | 'kd' | 'wd'
export type ChartTimeInterval = 1 | 5 | 10

export type ClientOnlySettingsStore = {
	displayTeamsNormalized: boolean
	chartTab: ChartTab
	chartTimeInterval: ChartTimeInterval
}

export const Store = Zus.createStore<ClientOnlySettingsStore>()(ZusMiddle.persist<ClientOnlySettingsStore>(() => ({
	displayTeamsNormalized: true,
	chartTab: 'population',
	chartTimeInterval: 5,
}), {
	name: 'settings:v1',
	storage: ZusMiddle.createJSONStorage(() => localStorage),
}))

// we're just hardcoding this to true for now
Store.setState({ displayTeamsNormalized: true })

export namespace Actions {
	export function setDisplayTeamsNormalized(value: boolean) {
		Store.setState({ displayTeamsNormalized: value })
	}
	export function setChartTab(value: ChartTab) {
		Store.setState({ chartTab: value })
	}
	export function setChartTimeInterval(value: ChartTimeInterval) {
		Store.setState({ chartTimeInterval: value })
	}
}

// legacy alias used by components that imported this as GlobalSettingsStore
export { Store as GlobalSettingsStore }
