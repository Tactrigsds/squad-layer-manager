import * as Zus from 'zustand'
import * as ZusMiddle from 'zustand/middleware'

export type ChartTab = 'population' | 'kd' | 'wd'
export type ChartTimeInterval = 1 | 5 | 10
// mirrors the ON_PRIMARY_PANEL variants in models/user-presence.ts (kept as a literal union so this module stays dependency-free)
export type PrimaryPanelTab = 'VIEWING_QUEUE' | 'VIEWING_TEAMS'

export type ClientOnlySettingsStore = {
	displayTeamsNormalized: boolean
	chartTab: ChartTab
	chartTimeInterval: ChartTimeInterval
	primaryPanelTab: PrimaryPanelTab
}

export const Store = Zus.createStore<ClientOnlySettingsStore>()(ZusMiddle.persist<ClientOnlySettingsStore>(() => ({
	displayTeamsNormalized: true,
	chartTab: 'population',
	chartTimeInterval: 5,
	primaryPanelTab: 'VIEWING_QUEUE',
}), {
	name: 'settings:v1',
	storage: ZusMiddle.createJSONStorage(() => localStorage),
}))

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
	export function setPrimaryPanelTab(value: PrimaryPanelTab) {
		Store.setState({ primaryPanelTab: value })
	}
}

// legacy alias used by components that imported this as GlobalSettingsStore
export { Store as GlobalSettingsStore }
