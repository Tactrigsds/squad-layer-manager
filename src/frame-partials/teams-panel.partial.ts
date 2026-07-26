import type { OnChangeFn, SortingState, Updater } from '@tanstack/react-table'

import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as FRM from '@/lib/frame'
import * as RSel from '@/lib/reselect'
import * as Str from '@/lib/string-utils'
import * as Zus from '@/lib/zustand'
import type * as BM from '@/models/battlemetrics.models'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import type * as ClientOnlySettings from '@/systems/client-only-settings.client'
import type { PublicSettings } from '@/systems/settings.server'

// A/B are the two per-team tables (desktop); 'combined' is the single-table mobile layout. Squad filters are
// per-table because a squad id only means something within one team's roster.
export type SquadFilterTarget = MH.NormedTeamId | 'combined'
// sorting either per-team table sorts both, so A and B share the 'teams' entry
export type SortingTarget = 'teams' | 'combined'

export const FILTER_ALL = '__all__'
// sentinel filter value matching players with no group ("Other") or no squad ("Unassigned")
export const FILTER_NONE = '__none__'

export const DEFAULT_TEAM_SORTING: SortingState = [{ id: 'squad', desc: false }]
export const DEFAULT_COMBINED_SORTING: SortingState = [
	{ id: 'faction', desc: false },
	{ id: 'squad', desc: false },
]

export type TeamsPanel = {
	searchQuery: string
	showSelected: boolean
	adminsOnly: boolean
	hideSpoilers: boolean
	// role and group are deliberately shared across the tables so a filter set on one applies to both
	roleFilter: string | null
	groupFilter: string | null
	squadFilters: Record<SquadFilterTarget, string | null>
	sorting: Record<SortingTarget, SortingState>
}

export type Store = { teamsPanel: TeamsPanel }

// read off the enclosing frame: the panel's filters compose with the roster and with the shared player selection
export type Deps = ChatPrt.Store & { playerSelection: Record<SM.PlayerId, boolean> }

export type Key = FRM.InstanceKeyOfState<Store & Deps>
export type KeyProp = { teamsPanel: Key }

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store & Deps>

// Must be initialized after the frame sets `playerSelection`: the sync below reads it on the very first update,
// and every partial's own init emits one.
export function initTeamsPanel(args: Args) {
	const set = Zus.toPartialSetter(args.set, 'teamsPanel')

	set({
		searchQuery: '',
		showSelected: false,
		adminsOnly: false,
		hideSpoilers: true,
		roleFilter: null,
		groupFilter: null,
		squadFilters: { A: null, B: null, combined: null },
		sorting: { teams: DEFAULT_TEAM_SORTING, combined: DEFAULT_COMBINED_SORTING },
	} satisfies TeamsPanel)

	args.cleanup.push(
		args.update$.subscribe(([state, prev]) => {
			// the toggle is disabled while nothing is selected, so an emptied selection has to switch it back off or the
			// tables would keep filtering to a selection the user can no longer see
			if (state.teamsPanel.showSelected && !hasSelection(state)) set({ showSelected: false })
			// the chat feed's ADMIN filter turns the roster filter on with it. Only the transition matters: this state
			// lives on the frame now, so there is no remount to catch up on the way a mount effect had to.
			if (ChatPrt.Sel.secondaryFilterState(state) === 'ADMIN' && ChatPrt.Sel.secondaryFilterState(prev) !== 'ADMIN') {
				set({ adminsOnly: true })
			}
		}),
	)
}

function hasSelection(state: Deps) {
	for (const id in state.playerSelection) {
		if (state.playerSelection[id]) return true
	}
	return false
}

// Player search: incremental/substring match on usernames, strict (exact whole-value) match on every
// other identifier (steam/eos/epic/playerController). Returns the set of matched indices in `players`.
export function matchPlayersBySearch<T extends { ids: SM.PlayerIds.Type }>(players: T[], searchQuery: string): Set<number> {
	const names = players.map((p) => p.ids.usernameNoTag ?? p.ids.username ?? '')
	const matched = new Set(Str.simpleStringMatch(names, searchQuery))
	if (searchQuery.trim()) {
		for (let i = 0; i < players.length; i++) {
			if (!matched.has(i) && SM.PlayerIds.matchesStrictSearch(players[i].ids, searchQuery)) matched.add(i)
		}
	}
	return matched
}

// displayIndex is the team's left-to-right position, so the faction column sorts into the same order the
// teams are laid out in (see MH.getDisplayedTeamOrder)
export type CombinedPlayer = TeamsPanelModels.EnrichedPlayer & { normedTeam: MH.NormedTeamId; displayIndex: number }

export type SquadWithTeam = { squad: SM.UniqueSquad; normedTeam: MH.NormedTeamId }

type Inputs = [
	store: Store & Deps,
	currentMatch: MH.MatchDetails | undefined,
	bmData: BM.PublicPlayerBmData,
	bmStore: BM.StoreState,
	settings: PublicSettings | undefined,
]

// the combined table lays both teams out in one list, so it additionally needs the displayed team order
type CombinedInputs = [...Inputs, clientSettings: ClientOnlySettings.ClientOnlySettingsStore]

const teamOrder = (...[, currentMatch, , , , clientSettings]: CombinedInputs) =>
	MH.getDisplayedTeamOrder(currentMatch?.ordinal ?? 0, clientSettings.displayTeamsNormalized)

const enrichedForTeam =
	(teamId: MH.NormedTeamId) =>
	(...[store, currentMatch, bmData, bmStore, settings]: CombinedInputs) =>
		TeamsPanelModels.Sel.playersForTeam(teamId)(store, currentMatch, bmData, bmStore, settings)

const matchesTeamSquadFilter = (player: TeamsPanelModels.EnrichedPlayer, squadFilter: string) =>
	squadFilter === FILTER_NONE ? player.squadId === null : player.squadId === Number(squadFilter)

const matchesCombinedSquadFilter = (player: CombinedPlayer, squadFilter: string) =>
	squadFilter === FILTER_NONE ? player.squadId === null : squadFilter === `${player.normedTeam}:${player.squadId}`

function applyFilters<T extends TeamsPanelModels.EnrichedPlayer>(
	players: T[],
	query: string,
	role: string | null,
	group: string | null,
	squad: string | null,
	adminsOnly: boolean,
	matchesSquadFilter: (player: T, squadFilter: string) => boolean,
): T[] {
	let result = players
	if (query.trim()) {
		const matched = matchPlayersBySearch(players, query)
		result = players.filter((_, i) => matched.has(i))
	}
	if (role !== null) result = result.filter((p) => p.role === role)
	if (group !== null) result = result.filter((p) => (group === FILTER_NONE ? p.group == null : p.group === group))
	if (squad !== null) result = result.filter((p) => matchesSquadFilter(p, squad))
	if (adminsOnly) result = result.filter((p) => p.isAdmin)
	return result
}

function applyShowSelected<T extends TeamsPanelModels.EnrichedPlayer>(
	players: T[],
	showSelected: boolean,
	selection: Record<SM.PlayerId, boolean>,
): T[] {
	return showSelected ? players.filter((p) => selection[SM.PlayerIds.getPlayerId(p.ids)]) : players
}

export namespace Sel {
	export function searchQuery(store: Store) {
		return store.teamsPanel.searchQuery
	}
	export function showSelected(store: Store) {
		return store.teamsPanel.showSelected
	}
	export function adminsOnly(store: Store) {
		return store.teamsPanel.adminsOnly
	}
	export function hideSpoilers(store: Store) {
		return store.teamsPanel.hideSpoilers
	}
	export function roleFilter(store: Store) {
		return store.teamsPanel.roleFilter
	}
	export function groupFilter(store: Store) {
		return store.teamsPanel.groupFilter
	}
	export function squadFilter(target: SquadFilterTarget) {
		return (store: Store) => store.teamsPanel.squadFilters[target]
	}
	export function sorting(target: SortingTarget) {
		return (store: Store) => store.teamsPanel.sorting[target]
	}

	// squad-separator rows are only coherent while the sort keeps same-squad rows contiguous
	export function squadGroupsEnabled(target: SortingTarget) {
		return (store: Store) => {
			const sort = store.teamsPanel.sorting[target]
			return target === 'teams' ? sort[0]?.id === 'squad' : sort[0]?.id === 'faction' && sort[1]?.id === 'squad'
		}
	}

	// the three column-header filter values as one stable object, so a table reads them in a single subscription
	export const columnFilters = RSel.memoizeFactory((target: SquadFilterTarget) =>
		RSel.createSelector([roleFilter, groupFilter, squadFilter(target)], (role, group, squad) => ({ role, group, squad })),
	)

	// what the panel header reads, likewise as one subscription
	export const headerState = RSel.createSelector(
		[showSelected, adminsOnly, hideSpoilers, roleFilter],
		(showSelected, adminsOnly, hideSpoilers, roleFilter) => ({ showSelected, adminsOnly, hideSpoilers, roleFilter }),
	)

	// filter options are drawn from both teams so the shared role/group filters offer every value
	export const availableRoles = RSel.createSelector([(...args: Inputs) => TeamsPanelModels.Sel.allEnrichedPlayers(...args)], (players) =>
		[...new Set(players.map((p) => p.role).filter((r): r is string => r != null))].sort(),
	)
	export const availableGroups = RSel.createSelector([(...args: Inputs) => TeamsPanelModels.Sel.allEnrichedPlayers(...args)], (players) =>
		[...new Set(players.map((p) => p.group).filter((g): g is string => g != null))].sort(),
	)

	export const filterOptions = RSel.createSelector([availableRoles, availableGroups], (roles, groups) => ({ roles, groups }))

	// squad creator eos ids resolved to display names, for the squad group-header rows. Both variants share one map:
	// a squad's creator is always on its own team, so the extra entries are never looked up.
	export const playerNamesById = RSel.createSelector(
		[(...args: Inputs) => TeamsPanelModels.Sel.allEnrichedPlayers(...args)],
		(players) => new Map(players.map((p) => [SM.PlayerIds.getPlayerId(p.ids), p.ids.usernameNoTag ?? p.ids.username ?? ''])),
	)

	export const squadsWithTeam = RSel.createDeepSelector(
		[
			(...[store, currentMatch]: CombinedInputs) => ChatPrt.Sel.squadsForTeam('A')(store, currentMatch),
			(...[store, currentMatch]: CombinedInputs) => ChatPrt.Sel.squadsForTeam('B')(store, currentMatch),
			teamOrder,
		],
		(squadsA, squadsB, order): SquadWithTeam[] =>
			order.flatMap((normedTeam) => (normedTeam === 'A' ? squadsA : squadsB).map((squad) => ({ squad, normedTeam }))),
	)

	const combinedPlayers = RSel.createDeepSelector(
		[enrichedForTeam('A'), enrichedForTeam('B'), teamOrder],
		(playersA, playersB, order): CombinedPlayer[] =>
			order.flatMap((normedTeam, displayIndex) =>
				(normedTeam === 'A' ? playersA : playersB).map((p) => ({ ...p, normedTeam, displayIndex })),
			),
	)

	// Search + role/group/squad/admin filters. Kept separate from the "show selected" pass below so a moving
	// selection (drag-select writes one entry per row the cursor crosses) does not re-run the whole chain.
	const filteredTeamPlayers = RSel.memoizeFactory((teamId: MH.NormedTeamId) =>
		RSel.createSelector(
			[
				(...args: Inputs) => TeamsPanelModels.Sel.playersForTeam(teamId)(...args),
				(...[store]: Inputs) => store.teamsPanel.searchQuery,
				(...[store]: Inputs) => store.teamsPanel.roleFilter,
				(...[store]: Inputs) => store.teamsPanel.groupFilter,
				(...[store]: Inputs) => store.teamsPanel.squadFilters[teamId],
				(...[store]: Inputs) => store.teamsPanel.adminsOnly,
			],
			(players, query, role, group, squad, adminsOnly) =>
				applyFilters(players, query, role, group, squad, adminsOnly, matchesTeamSquadFilter),
		),
	)

	export const displayedTeamPlayers = RSel.memoizeFactory((teamId: MH.NormedTeamId) =>
		RSel.createSelector(
			[
				filteredTeamPlayers(teamId),
				(...[store]: Inputs) => store.teamsPanel.showSelected,
				(...[store]: Inputs) => store.playerSelection,
			],
			applyShowSelected,
		),
	)

	const filteredCombinedPlayers = RSel.createSelector(
		[
			combinedPlayers,
			(...[store]: CombinedInputs) => store.teamsPanel.searchQuery,
			(...[store]: CombinedInputs) => store.teamsPanel.roleFilter,
			(...[store]: CombinedInputs) => store.teamsPanel.groupFilter,
			(...[store]: CombinedInputs) => store.teamsPanel.squadFilters.combined,
			(...[store]: CombinedInputs) => store.teamsPanel.adminsOnly,
		],
		(players, query, role, group, squad, adminsOnly) =>
			applyFilters(players, query, role, group, squad, adminsOnly, matchesCombinedSquadFilter),
	)

	export const displayedCombinedPlayers = RSel.createSelector(
		[
			filteredCombinedPlayers,
			(...[store]: CombinedInputs) => store.teamsPanel.showSelected,
			(...[store]: CombinedInputs) => store.playerSelection,
		],
		applyShowSelected,
	)
}

export namespace Actions {
	function slice(stores: KeyProp) {
		return Zus.toPartialStore(stores.teamsPanel, 'teamsPanel')
	}

	export function setSearchQuery(stores: KeyProp, searchQuery: string) {
		slice(stores).setState({ searchQuery })
	}

	export function setShowSelected(stores: KeyProp, showSelected: boolean) {
		slice(stores).setState({ showSelected })
	}

	export function setHideSpoilers(stores: KeyProp, hideSpoilers: boolean) {
		slice(stores).setState({ hideSpoilers })
	}

	// the roster filter and the chat feed's ADMIN filter are two views of one intent, so the toggle drives both
	export function setAdminsOnly(stores: KeyProp, adminsOnly: boolean) {
		slice(stores).setState({ adminsOnly })
		const chat: ChatPrt.KeyProp = { chat: stores.teamsPanel }
		if (adminsOnly) ChatPrt.Actions.setSecondaryFilterState(chat, 'ADMIN')
		else if (ChatPrt.Sel.secondaryFilterState(Zus.getState(stores.teamsPanel)) === 'ADMIN') {
			ChatPrt.Actions.setSecondaryFilterState(chat, 'DEFAULT')
		}
	}

	export function setRoleFilter(stores: KeyProp, roleFilter: string | null) {
		slice(stores).setState({ roleFilter })
	}

	export function setGroupFilter(stores: KeyProp, groupFilter: string | null) {
		slice(stores).setState({ groupFilter })
	}

	export function setSquadFilter(stores: KeyProp, target: SquadFilterTarget, value: string | null) {
		slice(stores).setState((s) => ({ squadFilters: { ...s.squadFilters, [target]: value } }))
	}

	export function setSorting(stores: KeyProp, target: SortingTarget, update: Updater<SortingState>) {
		slice(stores).setState((s) => ({
			sorting: { ...s.sorting, [target]: typeof update === 'function' ? update(s.sorting[target]) : update },
		}))
	}

	export function onSortingChange(stores: KeyProp, target: SortingTarget): OnChangeFn<SortingState> {
		return (update) => setSorting(stores, target, update)
	}

	// middle-clicking a column header clears that column's filter along with its sort
	export function clearColumnFilter(stores: KeyProp, target: SquadFilterTarget, columnId: string) {
		if (columnId === 'role') setRoleFilter(stores, null)
		if (columnId === 'group') setGroupFilter(stores, null)
		if (columnId === 'squad') setSquadFilter(stores, target, null)
	}

	// deliberately leaves hideSpoilers and showSelected alone (both are view preferences rather than filters), and
	// writes adminsOnly without touching the chat feed's own filter
	export function reset(stores: KeyProp) {
		slice(stores).setState({
			searchQuery: '',
			adminsOnly: false,
			roleFilter: null,
			groupFilter: null,
			squadFilters: { A: null, B: null, combined: null },
			sorting: { teams: DEFAULT_TEAM_SORTING, combined: DEFAULT_COMBINED_SORTING },
		})
	}
}
