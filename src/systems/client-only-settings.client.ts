import * as Zus from '@/lib/zustand'

export type ChartsTab = 'teams' | 'scoreline' | 'population'
export const CHARTS_TABS: readonly ChartsTab[] = ['teams', 'scoreline', 'population']
// what the scoreline chart plots over the match; 'lead' is team 1's kills minus team 2's
export type ScorelineMetric = 'kills' | 'deaths' | 'lead'
export const SCORELINE_METRICS: readonly ScorelineMetric[] = ['kills', 'deaths', 'lead']
// how much the population chart spans: the displayed match, or the last 6 hours, day or week of matches
export type PopulationRange = 'match' | '6h' | '24h' | '7d'
export const POPULATION_RANGES: readonly PopulationRange[] = ['match', '6h', '24h', '7d']
// what the population chart splits the players by, active and idle or team, or its figures over the range instead
export type PopulationSplit = 'activity' | 'teams' | 'stats'
export const POPULATION_SPLITS: readonly PopulationSplit[] = ['activity', 'teams', 'stats']
// how tall the population chart's y axis is: the server's player cap, or fitted to the players drawn
export type PopulationScale = 'max' | 'fitted'
export const POPULATION_SCALES: readonly PopulationScale[] = ['max', 'fitted']
// the parts of the population chart its legend can hide
export type PopulationMark = 'active' | 'idle' | 'matchStart' | 'roundEnd'
const NO_POPULATION_MARKS: readonly PopulationMark[] = []
// mirrors the primary panel codes in models/user-presence.ts (kept as a literal union so this module stays dependency-free)
export type PrimaryPanelTab = 'VIEWING_QUEUE' | 'VIEWING_TEAMS'
// the phone dashboard's screens; on the single-column layout `activity` is the Server Activity side and the rest the layers side
export type DashboardTab = 'matches' | 'queue' | 'teams' | 'activity'
export const DASHBOARD_TABS: readonly DashboardTab[] = ['matches', 'queue', 'teams', 'activity']

export type ClientOnlySettingsStore = {
	displayTeamsNormalized: boolean
	chartsTab: ChartsTab
	scorelineMetric: ScorelineMetric
	populationRange: PopulationRange
	populationSplit: PopulationSplit
	populationScale: PopulationScale
	populationHidden: PopulationMark[]
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
			populationRange: 'match',
			populationSplit: 'activity',
			populationScale: 'max',
			populationHidden: [],
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
	export function populationRange(s: ClientOnlySettingsStore): PopulationRange {
		return POPULATION_RANGES.includes(s.populationRange) ? s.populationRange : POPULATION_RANGES[0]
	}
	export function populationSplit(s: ClientOnlySettingsStore): PopulationSplit {
		return POPULATION_SPLITS.includes(s.populationSplit) ? s.populationSplit : POPULATION_SPLITS[0]
	}
	export function populationScale(s: ClientOnlySettingsStore): PopulationScale {
		return POPULATION_SCALES.includes(s.populationScale) ? s.populationScale : POPULATION_SCALES[0]
	}
	export function populationHidden(s: ClientOnlySettingsStore): readonly PopulationMark[] {
		return s.populationHidden ?? NO_POPULATION_MARKS
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
	export function setPopulationRange(value: PopulationRange) {
		Store.setState({ populationRange: value })
	}
	export function setPopulationSplit(value: PopulationSplit) {
		Store.setState({ populationSplit: value })
	}
	export function setPopulationScale(value: PopulationScale) {
		Store.setState({ populationScale: value })
	}
	export function togglePopulationMark(mark: PopulationMark) {
		const hidden = Sel.populationHidden(Store.getState())
		Store.setState({ populationHidden: hidden.includes(mark) ? hidden.filter((m) => m !== mark) : [...hidden, mark] })
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
