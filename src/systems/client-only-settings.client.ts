import * as Zus from '@/lib/zustand'

export type ChartTab = 'population' | 'kd' | 'wd'
export type ChartTimeInterval = 1 | 5 | 10
// mirrors the ON_PRIMARY_PANEL variants in models/user-presence.ts (kept as a literal union so this module stays dependency-free)
export type PrimaryPanelTab = 'VIEWING_QUEUE' | 'VIEWING_TEAMS'

export type ClientOnlySettingsStore = {
	displayTeamsNormalized: boolean
	chartTab: ChartTab
	chartTimeInterval: ChartTimeInterval
	primaryPanelTab: PrimaryPanelTab
	// commands the admin pinned to the top of the commands page, in the order they pinned them. Held as CommandIds
	// rather than command strings so a pin survives an admin renaming the command; ids for commands that no longer
	// exist are ignored on read rather than pruned, since a downgrade shouldn't silently drop them.
	pinnedCommands: string[]
	// tutorial scenarios the user has finished, held as ScenarioIds (string to keep this module dependency-free, as
	// pinnedCommands does). Additive: absent from older persisted state, so it merges to [] on read.
	completedTutorials: string[]
}

export const Store = Zus.createStore<ClientOnlySettingsStore>()(
	Zus.persist<ClientOnlySettingsStore>(
		() => ({
			displayTeamsNormalized: true,
			chartTab: 'population',
			chartTimeInterval: 5,
			primaryPanelTab: 'VIEWING_QUEUE',
			pinnedCommands: [],
			completedTutorials: [],
		}),
		{
			name: 'settings:v1',
			storage: Zus.createJSONStorage(() => localStorage),
		},
	),
)

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
	export function toggleCommandPinned(commandId: string) {
		const pinned = Store.getState().pinnedCommands
		Store.setState({
			pinnedCommands: pinned.includes(commandId) ? pinned.filter((id) => id !== commandId) : [...pinned, commandId],
		})
	}
	export function markTutorialComplete(scenarioId: string) {
		const done = Store.getState().completedTutorials
		if (!done.includes(scenarioId)) Store.setState({ completedTutorials: [...done, scenarioId] })
	}
}

// legacy alias used by components that imported this as GlobalSettingsStore
export { Store as GlobalSettingsStore }
