import * as Zus from '@/lib/zustand'

export type ChartsTab = 'teams' | 'scoreline'
export const CHARTS_TABS: readonly ChartsTab[] = ['teams', 'scoreline']
// what the scoreline chart plots over the match; 'lead' is team 1's kills minus team 2's
export type ScorelineMetric = 'kills' | 'deaths' | 'lead'
export const SCORELINE_METRICS: readonly ScorelineMetric[] = ['kills', 'deaths', 'lead']
// mirrors the ON_PRIMARY_PANEL variants in models/user-presence.ts (kept as a literal union so this module stays dependency-free)
export type PrimaryPanelTab = 'VIEWING_QUEUE' | 'VIEWING_TEAMS'
// the phone dashboard's screens; on the single-column layout `activity` is the Server Activity side and the rest the layers side
export type DashboardTab = 'matches' | 'queue' | 'teams' | 'activity'
export const DASHBOARD_TABS: readonly DashboardTab[] = ['matches', 'queue', 'teams', 'activity']

export type ClientOnlySettingsStore = {
	displayTeamsNormalized: boolean
	chartsTab: ChartsTab
	scorelineMetric: ScorelineMetric
	primaryPanelTab: PrimaryPanelTab
	// where a bare visit to the dashboard lands; the tab itself lives in the url (see squad-server.client's useDashboardTab)
	dashboardTab: DashboardTab
	// commands the admin pinned to the top of the commands page, in the order they pinned them. Held as CommandIds
	// rather than command strings so a pin survives an admin renaming the command; ids for commands that no longer
	// exist are ignored on read rather than pruned, since a downgrade shouldn't silently drop them.
	pinnedCommands: string[]
}

export const Store = Zus.createStore<ClientOnlySettingsStore>()(
	Zus.persist<ClientOnlySettingsStore>(
		() => ({
			displayTeamsNormalized: true,
			chartsTab: 'teams',
			scorelineMetric: 'kills',
			primaryPanelTab: 'VIEWING_QUEUE',
			dashboardTab: 'queue',
			pinnedCommands: [],
		}),
		{
			name: 'settings:v1',
			storage: Zus.createJSONStorage(() => localStorage),
		},
	),
)

export namespace Sel {
	// a stored tab this build no longer has falls back to the first
	export function chartsTab(s: ClientOnlySettingsStore): ChartsTab {
		return CHARTS_TABS.includes(s.chartsTab) ? s.chartsTab : CHARTS_TABS[0]
	}
	export function scorelineMetric(s: ClientOnlySettingsStore): ScorelineMetric {
		return SCORELINE_METRICS.includes(s.scorelineMetric) ? s.scorelineMetric : SCORELINE_METRICS[0]
	}
}

export namespace Actions {
	export function setDisplayTeamsNormalized(value: boolean) {
		Store.setState({ displayTeamsNormalized: value })
	}
	export function setChartsTab(value: ChartsTab) {
		Store.setState({ chartsTab: value })
	}
	export function setScorelineMetric(value: ScorelineMetric) {
		Store.setState({ scorelineMetric: value })
	}
	export function setPrimaryPanelTab(value: PrimaryPanelTab) {
		Store.setState({ primaryPanelTab: value })
	}
	export function setDashboardTab(value: DashboardTab) {
		Store.setState({ dashboardTab: value })
	}
	export function toggleCommandPinned(commandId: string) {
		const pinned = Store.getState().pinnedCommands
		Store.setState({
			pinnedCommands: pinned.includes(commandId) ? pinned.filter((id) => id !== commandId) : [...pinned, commandId],
		})
	}
}

// legacy alias used by components that imported this as GlobalSettingsStore
export { Store as GlobalSettingsStore }
