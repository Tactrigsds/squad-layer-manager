import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { distinctDeepEquals, sleep } from '@/lib/async'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as BB from '@/models/backburner.models'
import * as CB from '@/models/constraint-builders'
import * as EFB from '@/models/editable-filter-builders'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import type React from 'react'
import * as Rx from 'rxjs'
import { frameManager } from './frame-manager'

// The "Request a layer" editor: a pared-down layer-filter-menu (components or a specific layer string,
// synced Layer<->components like the layer-select menu) plus a matchup and applied filter entities. All
// picker options narrow under everything else selected plus the generation pool, exactly like that menu.

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>

// which of the two layer identity views the user is editing. They stay in sync (a picked layer fills the
// components and vice versa, via the filter menu's own logic); the tab decides which lands in the template
export type IdentityTab = 'components' | 'layer'

export const COMPONENT_FIELDS = ['Map', 'Gamemode', 'LayerVersion', 'Collection'] as const

// per matchup side, the values each dimension may take without emptying the solution set
export type MatchupSideOptions = [Partial<Record<F.TeamColumn, string[]>>, Partial<Record<F.TeamColumn, string[]>>]

type Input = {
	colConfig: LQY.EffectiveColumnAndTableConfig
	instanceId: string
	startingFilter?: F.FilterNode
} & Partial<SquadServerFrame.KeyProp>

export function createInput(opts: { startingFilter?: F.FilterNode } & Partial<SquadServerFrame.KeyProp>): Input {
	return {
		colConfig: ConfigClient.getColConfig(),
		instanceId: createId(4),
		startingFilter: opts.startingFilter,
		squadServer: opts.squadServer,
	}
}

type Primary = {
	input: Input
	activeTab: IdentityTab
	matchup: F.EditableMatchupNode
	// template parts the dialog doesn't edit (sizes from chat, custom conditions); carried through save untouched
	preserved: Pick<BB.TemplateParts, 'sizes' | 'other'>
	// layers matching the request within the generation pool, from the same query that narrows the options
	matchingCount: number | null
	matchupSideOptions: MatchupSideOptions | null
}

type State = Primary & LayerFilterMenuPrt.Store & LayerFilterMenuPrt.Predicates & AppliedFiltersPrt.Store

export type Types = {
	name: 'backburnerRequest'
	key: FRM.RawInstanceKey<{ instanceId: string }>
	input: Input
	state: State
}
type Frame = FRM.Frame<Types>

// merged templates can hold several values per component, which render and stay editable as an in-comparison
function componentComp(column: string, values: string[]): F.EditableCompNode {
	return values.length > 1 ? EFB.inValues(column, values) : EFB.eq(column, values[0])
}

function buildMenuItems(parts: BB.TemplateParts): Record<string, F.EditableCompNode> {
	return {
		// the Layer value is applied post-init via the menu's setComparison so it syncs into the components
		Layer: EFB.eq('Layer'),
		Map: componentComp('Map', parts.maps),
		Gamemode: componentComp('Gamemode', parts.gamemodes),
		LayerVersion: componentComp('LayerVersion', parts.versions),
		Collection: componentComp('Collection', parts.collections),
	}
}

// the single either-team picks the chat grammar produces are folded onto one side of the matchup editor;
// a full matchup node seeds it verbatim
function seedMatchup(parts: BB.TemplateParts): F.EditableMatchupNode {
	if (parts.matchup) return structuredClone(parts.matchup)
	const side: F.MatchupTeamSpec = {}
	if (parts.factions.length > 0) side.Faction = [...parts.factions]
	if (parts.alliances.length > 0) side.Alliance = [...parts.alliances]
	if (parts.units.length > 0) side.Unit = [...parts.units]
	return FB.allowMatchups([side, {}]) as F.MatchupNode
}

const setup: Frame['setup'] = (args) => {
	const set = args.set
	const parts = args.input.startingFilter ? BB.parseTemplateParts(args.input.startingFilter) : BB.emptyTemplateParts()

	set(
		{
			input: args.input,
			activeTab: parts.layers.length > 0 ? 'layer' : 'components',
			matchup: seedMatchup(parts),
			preserved: { sizes: parts.sizes, other: parts.other },
			matchingCount: null,
			matchupSideOptions: null,
		} satisfies Primary,
	)

	// the applied-filters partial reads squadServer from state (pool filter, configured selectable filters)
	set({ squadServer: args.input.squadServer } satisfies AppliedFiltersPrt.Predicates)

	set(
		{
			resetAllConstraints() {
				LayerFilterMenuPrt.Actions.resetAllFilters({ filterMenu: args.key })
				AppliedFiltersPrt.Actions.disableAllAppliedFilters({ appliedFilters: args.key })
				ZusUtils.resolveStore<State>(args.key).setState({ matchup: FB.allowMatchups([{}, {}]) as F.MatchupNode })
			},
		} satisfies LayerFilterMenuPrt.Predicates,
	)

	LayerFilterMenuPrt.initLayerFilterMenuStore({
		...args,
		input: {
			colConfig: args.input.colConfig,
			items: buildMenuItems(parts),
			emptyItems: buildMenuItems(BB.emptyTemplateParts()),
		},
	})
	// a layer-based template runs through the menu's own sync so the component fields reflect it too
	if (parts.layers[0]) {
		LayerFilterMenuPrt.Actions.setComparison({ filterMenu: args.key }, 'Layer', EFB.eq('Layer', parts.layers[0]))
	}
	// extras are scoped to this dialog: a one-off filter pick for a request shouldn't edit the user's saved set
	AppliedFiltersPrt.initAppliedFiltersStore({ ...args, input: { context: 'add', extraFiltersScope: 'local' } })

	// the partial seeds the configured selectable filters asynchronously (it waits for the filter entities);
	// run after it to (1) start every chip disabled -- a template should only carry filters the user actively
	// picked -- and (2) apply the edited template's own filter states, pulling them in as extras when needed.
	// the pool filter is special: it rides the pool toggle (on by default for new requests) rather than a row
	void (async () => {
		await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		await sleep(0)
		if (args.sub.closed) return
		const poolFilter = args.input.squadServer
			? SquadServerFrame.Sel.settings(ZusUtils.getState(args.input.squadServer)).queue.mainPool.poolFilter
			: null
		const seedFilterIds = parts.filterIds.filter(id => id !== poolFilter?.filterId)
		const seedExcludedIds = parts.excludedFilterIds.filter(id => id !== poolFilter?.filterId)
		const poolApplied = !args.input.startingFilter || !poolFilter
			? true
			: (poolFilter.mode === 'include'
				? parts.filterIds.includes(poolFilter.filterId)
				: parts.excludedFilterIds.includes(poolFilter.filterId))
		ZusUtils.resolveStore<State>(args.key).setState(state => {
			const filterStates = new Map(state.appliedFilters.filterStates)
			for (const id of filterStates.keys()) filterStates.set(id, 'disabled')
			for (const id of seedFilterIds) filterStates.set(id, 'regular')
			for (const id of seedExcludedIds) filterStates.set(id, 'inverted')
			return { appliedFilters: { ...state.appliedFilters, filterStates, poolApplied } }
		})
		const templateFilterIds = [...seedFilterIds, ...seedExcludedIds]
		if (templateFilterIds.length > 0) {
			AppliedFiltersPrt.Actions.selectExtraFilters(
				{ appliedFilters: args.key },
				prev => Array.from(new Set([...prev, ...templateFilterIds])),
			)
		}
	})()

	// a query that fails to build (e.g. an applied filter referencing values the layer data no longer maps)
	// degrades to no count and unfiltered options rather than killing the stream or looping
	const firstCount = (input: LQY.LayersQueryInput): Rx.Observable<number | null> =>
		LayerQueriesClient.queryLayers$(input).pipe(
			Rx.filter(packet => packet.code === 'layers-page'),
			Rx.map(packet => (packet.code === 'layers-page' ? packet.totalCount : null)),
			Rx.take(1),
			Rx.defaultIfEmpty(null),
			Rx.catchError(error => {
				console.warn('backburner request count query failed:', error)
				return Rx.of(null)
			}),
		)
	const firstMenuValues = (input: LQY.LayersQueryInput): Rx.Observable<Record<string, string[]> | null> =>
		LayerQueriesClient.queryLayers$(input).pipe(
			Rx.filter(packet => packet.code === 'menu-item-possible-values'),
			Rx.map(packet => (packet.code === 'menu-item-possible-values' ? packet.values : null)),
			Rx.take(1),
			Rx.defaultIfEmpty(null),
			Rx.catchError(error => {
				console.warn('backburner request options query failed:', error)
				return Rx.of(null)
			}),
		)

	const squadServer = args.input.squadServer
	const stateAndServer$: Rx.Observable<readonly [State, SquadServerFrame.State | undefined]> = squadServer
		? Rx.combineLatest([args.update$, ZusUtils.toObservable(squadServer, true)]).pipe(
			Rx.map(([[state], [server]]) => [state, server] as const),
		)
		: args.update$.pipe(Rx.map(([state]) => [state, undefined] as const))
	args.sub.add(
		stateAndServer$.pipe(
			Rx.map(([state]) => Sel.queryPlan(state)),
			distinctDeepEquals(),
			Rx.switchMap(plan =>
				Rx.combineLatest([
					firstCount(plan.count),
					plan.orientations.length > 0
						? Rx.combineLatest(plan.orientations.map(orientation => firstMenuValues(orientation.input)))
						: Rx.of([] as (Record<string, string[]> | null)[]),
				]).pipe(Rx.map(([count, valueSets]) => ({ plan, count, valueSets })))
			),
		).subscribe(({ plan, count, valueSets }) => {
			set({ matchingCount: count, ...mergeOptionSets(plan, valueSets) })
		}),
	)
}

const IDENTITY_FIELDS = ['Layer', ...COMPONENT_FIELDS] as const

// folds the per-orientation possible-value sets back into (a) identity-field options (the union across
// orientations equals querying under the either-orientation matchup) and (b) per-side matchup dimension
// options, mapped back from the pinned team columns
function mergeOptionSets(
	plan: Sel.QueryPlan,
	valueSets: (Record<string, string[]> | null)[],
): Pick<State, 'filterMenuItemPossibleValues' | 'matchupSideOptions'> {
	const successful = valueSets.filter((set): set is Record<string, string[]> => set !== null)
	if (successful.length === 0 || successful.length < valueSets.length) {
		return { filterMenuItemPossibleValues: undefined, matchupSideOptions: null }
	}
	const filterMenuItemPossibleValues: Record<string, string[]> = {}
	for (const field of IDENTITY_FIELDS) {
		filterMenuItemPossibleValues[field] = Array.from(new Set(successful.flatMap(set => set[field] ?? []))).sort()
	}
	const union = (...lists: (string[] | undefined)[]) => Array.from(new Set(lists.flatMap(list => list ?? []))).sort()
	const sideOptions: MatchupSideOptions = [{}, {}]
	for (const column of F.TEAM_COLUMNS) {
		const one = F.resolveTeamColumn(column, 1)
		const two = F.resolveTeamColumn(column, 2)
		if (plan.mode === 'dual') {
			const [aFirst, aSecond] = successful
			sideOptions[0][column] = union(aFirst[one], aSecond[two])
			sideOptions[1][column] = union(aFirst[two], aSecond[one])
		} else if (plan.mode === 'locked') {
			sideOptions[0][column] = union(successful[0][one])
			sideOptions[1][column] = union(successful[0][two])
		} else {
			// unlocked with interchangeable sides: either side may land on either team
			const both = union(successful[0][one], successful[0][two])
			sideOptions[0][column] = both
			sideOptions[1][column] = both
		}
	}
	return { filterMenuItemPossibleValues, matchupSideOptions: sideOptions }
}

export const frame = frameManager.createFrame<Types>({
	name: 'backburnerRequest',
	setup,
	createKey: (frameId, input) => ({ frameId, instanceId: input.instanceId }),
})

function stringsOfComp(comp: F.EditableCompNode | undefined): string[] {
	if (!comp) return []
	const values = F.compValues(comp)
	if (values) return values.filter((v): v is string => typeof v === 'string')
	const value = F.compValue(comp)
	return typeof value === 'string' ? [value] : []
}

export namespace Sel {
	// pool membership + the user's applied filters + generation-only filters + preserved chat parts:
	// everything except the matchup and the identity fields, which each query expresses its own way
	function baseConstraints(state: State): LQY.Constraint[] {
		// the applied filters (pool toggle, chips, extras) become part of the template itself, so the preview
		// applies nothing beyond them and the parts the dialog carries through untouched
		const constraints: LQY.Constraint[] = [...AppliedFiltersPrt.Sel.constraints(state)]
		const preservedFilter = BB.buildTemplateFilter(state.preserved)
		if (preservedFilter.type === 'and' && preservedFilter.children.length > 0) {
			constraints.push(CB.filterAnon('backburner-request:preserved', preservedFilter))
		}
		return constraints
	}

	export type QueryPlan = {
		count: LQY.LayersQueryInput
		// how the matchup was pinned across the orientation queries, which decides how their results map
		// back onto the two sides
		mode: 'locked' | 'single' | 'dual'
		orientations: { aTeam: 1 | 2; input: LQY.LayersQueryInput }[]
	}

	// The count query carries the matchup verbatim (either-orientation lowering). The option queries pin the
	// matchup to a concrete orientation and express each side dimension as a filter-menu item on the pinned
	// team column: each picker's options are then computed under every other condition -- same-side
	// dimensions included, so an alliance pick narrows that side's factions and a faction pick its units --
	// exactly like the layer filter menu. An unlocked matchup gets one query per orientation; the union of
	// the two equals querying under the either-orientation node.
	export function queryPlan(state: State): QueryPlan {
		const base = baseConstraints(state)
		const menuConstraints = LayerFilterMenuPrt.Sel.filterMenuConstraints(state)
		const identityItems = menuConstraints.flatMap(constraint => constraint.type === 'filter-menu-items' ? constraint.items : [])

		const countConstraints = [...base, ...menuConstraints]
		if (BB.matchupHasValues(state.matchup)) {
			countConstraints.push(CB.filterAnon('backburner-request:matchup', FB.and([state.matchup])))
		}

		const orientationInput = (aTeam: 1 | 2): LQY.LayersQueryInput => {
			const teamItems: LQY.FilterMenuItem[] = []
			for (const [sideIndex, team] of [[0, aTeam], [1, aTeam === 1 ? 2 : 1]] as [0 | 1, 1 | 2][]) {
				for (const column of F.TEAM_COLUMNS) {
					const values = (state.matchup.teams[sideIndex][column] ?? []).filter(
						(value): value is string => typeof value === 'string',
					)
					const field = F.resolveTeamColumn(column, team)
					teamItems.push({
						field,
						node: values.length === 1 ? FB.eq(field, values[0]) : values.length > 1 ? FB.inValues(field, values) : undefined,
						returnPossibleValues: true,
					})
				}
			}
			return {
				constraints: [...base, CB.filterMenuItems('backburner-request:orientation', [...identityItems, ...teamItems])],
				pageSize: 1,
				sort: null,
			}
		}

		const mode: QueryPlan['mode'] = state.matchup.locked
			? 'locked'
			: Obj.deepEqual(state.matchup.teams[0], state.matchup.teams[1])
			? 'single'
			: 'dual'
		const orientations = mode === 'dual'
			? [{ aTeam: 1 as const, input: orientationInput(1) }, { aTeam: 2 as const, input: orientationInput(2) }]
			: [{ aTeam: 1 as const, input: orientationInput(1) }]
		return { count: { constraints: countConstraints, pageSize: 1, sort: null }, mode, orientations }
	}

	export function templateFilter(state: State): F.FilterNode {
		const menuValues = (field: string) => stringsOfComp(state.filterMenu.menuItems[field])
		const layers = menuValues('Layer')
		const components = {
			maps: menuValues('Map'),
			gamemodes: menuValues('Gamemode'),
			versions: menuValues('LayerVersion'),
			collections: menuValues('Collection'),
		}
		const componentsPicked = Object.values(components).some(values => values.length > 0)
		// the two views are kept in sync by the menu, so the tab just decides which representation lands in
		// the template, falling back to the other when the active one is empty
		const useLayer = layers.length > 0 && (state.activeTab === 'layer' || !componentsPicked)
		const filterIds: string[] = []
		const excludedFilterIds: string[] = []
		for (const [filterId, applyAs] of state.appliedFilters.filterStates) {
			if (applyAs === 'regular') filterIds.push(filterId)
			else if (applyAs === 'inverted') excludedFilterIds.push(filterId)
		}
		// the pool toggle writes pool membership into the template itself
		const poolFilter = state.squadServer
			? SquadServerFrame.Sel.settings(ZusUtils.getState(state.squadServer)).queue.mainPool.poolFilter
			: null
		if (poolFilter && state.appliedFilters.poolApplied) {
			;(poolFilter.mode === 'include' ? filterIds : excludedFilterIds).push(poolFilter.filterId)
		}
		return BB.buildTemplateFilter({
			...(useLayer ? { layers } : components),
			matchup: BB.matchupHasValues(state.matchup) ? state.matchup : undefined,
			filterIds,
			excludedFilterIds,
			...state.preserved,
		})
	}
}

export namespace Actions {
	// straight through to the menu's own logic: picking a Layer fills the component fields from the parsed
	// layer string, editing a component re-derives or clears the Layer, and Map/Gamemode changes reset the
	// version -- the same behavior as the layer-select menu
	export function setMenuComparison(stores: KeyProp, field: string, update: React.SetStateAction<F.EditableCompNode>) {
		LayerFilterMenuPrt.Actions.setComparison({ filterMenu: stores.backburnerRequest }, field, update)
	}

	export function resetMenuField(stores: KeyProp, field: string) {
		LayerFilterMenuPrt.Actions.resetFilter({ filterMenu: stores.backburnerRequest }, field)
	}

	export function setActiveTab(stores: KeyProp, activeTab: IdentityTab) {
		ZusUtils.resolveStore<State>(stores.backburnerRequest).setState({ activeTab })
	}

	export function updateMatchup(stores: KeyProp, update: React.SetStateAction<F.EditableMatchupNode>) {
		ZusUtils.resolveStore<State>(stores.backburnerRequest).setState(state => ({
			matchup: typeof update === 'function' ? update(state.matchup) : update,
		}))
	}
}
