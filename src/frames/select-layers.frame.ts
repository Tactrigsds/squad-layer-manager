import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import * as LayerSearchPrt from '@/frame-partials/layer-search.partial'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as CS from '@/models/context-shared.models'
import * as EFB from '@/models/editable-filter-builders.models'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns.models'
import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as L from '@/models/layer.models'
import * as SETTINGS from '@/models/settings.models'
import * as ConfigClient from '@/systems/config.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'

import { frameManager } from './frame-manager'

export type SelectType = 'generic' | 'indexed'
export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>

export function createInput(
	opts: {
		selected?: L.LayerId[]
		initialEditedLayerId?: L.LayerId
		cursor?: LL.Cursor
		maxSelected?: number
		minSelected?: number
		sharedInstanceId?: string
		// seed the layer-select menu from a backburner template (matchup left -> Team 1, right -> Team 2)
		startingTemplate?: F.FilterNode
		rememberCollection?: boolean
	} & Partial<SquadServerFrame.KeyProp>,
): Input {
	const colConfig = ConfigClient.getColConfig()
	const base: BaseInput = {
		colConfig,
		initialEditedLayerId: opts.initialEditedLayerId,
		instanceId: opts.sharedInstanceId ?? createId(4),
		cursor: opts.cursor,
		squadServer: opts.squadServer,
		startingMenuItems: opts.startingTemplate ? LayerFilterMenuPrt.menuItemsFromTemplate(opts.startingTemplate, colConfig) : undefined,
		rememberCollection: opts.rememberCollection,
	}
	return {
		...LayerTablePrt.getInputDefaults({
			...opts,
			colConfig: ConfigClient.getColConfig(),
			pageSize: 16,
			...(opts.initialEditedLayerId
				? {
						selected: [opts.initialEditedLayerId],
						maxSelected: opts.maxSelected ?? 1,
						minSelected: opts.minSelected ?? 1,
					}
				: {}),
		}),
		...base,
	}
}

type BaseInput = {
	colConfig: LQY.EffectiveColumnAndTableConfig
	cursor?: LL.Cursor
	initialEditedLayerId?: L.LayerId
	instanceId: string
	startingMenuItems?: Record<string, F.EditableCompNode>
	rememberCollection?: boolean
} & Partial<SquadServerFrame.KeyProp>

type Input = BaseInput & LayerTablePrt.Input

type Primary = {
	initialEditedLayerId?: L.LayerId
	cursor: LL.Cursor | undefined
	input: Input
	// how many layers the applied filters allow before the search narrows them. It costs a query of its own, so it
	// is only kept up to date while something watches it (see Actions.watchFiltersOnlyCount)
	filtersOnlyCount: { watchers: number; value: number | null }
}

type State = Primary &
	AppliedFiltersPrt.Store &
	PoolCheckboxesPrt.Store &
	LayerFilterMenuPrt.Store &
	LayerSearchPrt.Store &
	LayerTablePrt.Store &
	LayerTablePrt.Predicates &
	//  setup for this is handled by the layer table partial
	LayerFilterMenuPrt.Predicates

export type Types = {
	name: 'selectLayers'
	key: FRM.RawInstanceKey<{ editedLayerId?: L.LayerId; instanceId: string }>
	input: Input
	state: State
}

type Frame = FRM.Frame<Types>

const setup: Frame['setup'] = (args) => {
	const set = args.set
	const input = args.input
	const colConfig = input.colConfig

	set({
		cursor: args.input.cursor,
		input,
		initialEditedLayerId: args.input.initialEditedLayerId,
		filtersOnlyCount: { watchers: 0, value: null },
	} satisfies Primary)

	// the applied-filters partial reads squadServer from state to seed the pool's configured filters; without
	// this its predicate is unset and pool filters never apply in the select-layers dialog
	set({ squadServer: input.squadServer } satisfies AppliedFiltersPrt.Predicates)

	set({
		baseQueryInput: undefined,
		onLayerFocused: (layerId) => {
			const defaultFields = getFilterMenuDefaultFields(layerId, colConfig, { keepCollection: true })
			const itemState = LayerFilterMenuPrt.getDefaultFilterMenuItemState(defaultFields, colConfig)
			LayerFilterMenuPrt.Actions.setMenuItems({ filterMenu: args.key }, itemState)
		},
	} satisfies LayerTablePrt.Predicates)

	set({
		resetAllConstraints() {
			LayerFilterMenuPrt.Actions.resetAllFilters({ filterMenu: args.key })
			PoolCheckboxesPrt.Actions.setCheckbox({ poolCheckboxes: args.key }, 'dnr', 'disabled')
			AppliedFiltersPrt.Actions.disableAllAppliedFilters({ appliedFilters: args.key })
		},
	} satisfies LayerFilterMenuPrt.Predicates)

	AppliedFiltersPrt.initAppliedFiltersStore({
		...args,
		input: input.initialEditedLayerId ? { context: 'edit', editedLayerId: input.initialEditedLayerId } : { context: 'add' },
	})
	PoolCheckboxesPrt.initNewPoolCheckboxes({ ...args, input: { defaultState: { dnr: 'disabled' } } })
	let startingMenuItems = input.startingMenuItems
	if (!startingMenuItems && input.rememberCollection) {
		startingMenuItems = LayerFilterMenuPrt.getDefaultFilterMenuItemState(
			getFilterMenuDefaultFields(input.initialEditedLayerId, input.colConfig),
			input.colConfig,
		)
		startingMenuItems.Collection = readRememberedCollection()
	}

	LayerFilterMenuPrt.initLayerFilterMenuStore({
		...args,
		input: startingMenuItems
			? {
					colConfig: input.colConfig,
					items: startingMenuItems,
					emptyItems: LayerFilterMenuPrt.getDefaultFilterMenuItemState({}, input.colConfig),
				}
			: { colConfig: input.colConfig, defaultFields: getFilterMenuDefaultFields(input.initialEditedLayerId, input.colConfig) },
	})
	LayerSearchPrt.initLayerSearch({ ...args, input: {} })
	// set before the table starts querying, so its first query is not one built without the pool and repeat rules
	set({ baseQueryInput: Sel.baseQueryInput(args.get(), input.squadServer ? Zus.getState(input.squadServer) : undefined) })
	LayerTablePrt.initLayerTable(args)

	let baseQueryInput$: Rx.Observable<LQY.BaseQueryInput>

	if (input.squadServer) {
		baseQueryInput$ = Rx.combineLatest([args.update$, Zus.toObservable(input.squadServer, true)]).pipe(
			Rx.map(([[state], [squadServer]]) => {
				return Sel.baseQueryInput(state, squadServer)
			}),
		)
	} else {
		baseQueryInput$ = args.update$.pipe(Rx.map(([state]) => Sel.baseQueryInput(state, undefined)))
	}
	args.cleanup.push(
		baseQueryInput$.pipe(Rx.retry({ count: Infinity, delay: 1000 }), Rx.Ext.distinctDeepEquals()).subscribe((baseQueryInput) => {
			set({ baseQueryInput })
		}),
	)

	const squadServer$ = input.squadServer ? Zus.toObservable(input.squadServer, true).pipe(Rx.map(([state]) => state)) : Rx.of(undefined)
	args.cleanup.push(
		Rx.combineLatest([args.update$, squadServer$])
			.pipe(
				Rx.map(([[state], squadServer]) =>
					state.filtersOnlyCount.watchers > 0
						? LayerQueriesClient.getQueryLayersInput(Sel.preMenuFilteredQueryInput(state, squadServer), {
								cfg: colConfig,
								pageSize: 1,
								sort: LQY.DEFAULT_SORT,
							})
						: null,
				),
				Rx.Ext.distinctDeepEquals(),
				Rx.throttleTime(500, Rx.asyncScheduler, { leading: true, trailing: true }),
				Rx.switchMap((queryInput) =>
					queryInput
						? LayerQueriesClient.queryLayers$(queryInput).pipe(
								Rx.filter((packet) => packet.code === 'layers-page'),
								Rx.map((packet) => packet.totalCount),
							)
						: Rx.EMPTY,
				),
				Rx.retry({ count: Infinity, delay: 1000 }),
			)
			.subscribe((value) => {
				set((state) => ({ filtersOnlyCount: { ...state.filtersOnlyCount, value } }))
			}),
	)

	if (input.rememberCollection) {
		args.cleanup.push(
			args.update$
				.pipe(
					Rx.map(([state]) => state.filterMenu.menuItems.Collection),
					Rx.Ext.distinctDeepEquals(),
				)
				.subscribe(writeRememberedCollection),
		)
	}
}

// The catalog holds the mod collections alongside OWI, so a dialog that opens unpinned buries the vanilla layers.
// `rememberCollection` opens it on the default collection, then on whatever the user last set the Collection menu
// item to. The comparison is stored whole rather than as a bare collection name, so a change of operator comes
// back with it. A value the catalog has since dropped is left alone, as a stale saved filter is.
const REMEMBERED_COLLECTION_KEY = 'selectLayersCollection:v1'

function readRememberedCollection(components = L.StaticLayerComponents): F.EditableCompNode {
	const stored = localStorage.getItem(REMEMBERED_COLLECTION_KEY)
	if (stored !== null) {
		try {
			const parsed = F.EditableCompNodeSchema.parse(JSON.parse(stored))
			if (F.compAnchorColumn(parsed) === 'Collection') return parsed
		} catch {
			// fall through to the default: a key we cannot read is one the user can simply set again
		}
	}
	return EFB.eq('Collection', L.getDefaultCollection(components))
}

function writeRememberedCollection(comp: F.EditableCompNode) {
	localStorage.setItem(REMEMBERED_COLLECTION_KEY, JSON.stringify(comp))
}

// const onInputChanged: Frame['onInputChanged'] = (newInput, setupArgs) => {
// 	// column visibility not handled, and colConfig is never expected to change

// 	const get = setupArgs.get
// 	// with this we're expecting that we can use one frame for all instances
// 	get().setCursor(newInput.cursor)
// 	setupArgs.set(s => ({ layerTable: { ...s.layerTable, minSelected: newInput.minSelected, maxSelected: newInput.maxSelected } }))
// 	get().layerTable.setPageSize(newInput.pageSize)
// 	get().layerTable.setSelected(newInput.selected)
// 	get().layerTable.setSort(newInput.sort)
// 	get().setCheckbox('dnr', !newInput.initialEditedLayerId)

// 	if (newInput.initialEditedLayerId !== get().initialEditedLayerId) {
// 		const defaultFields = getFilterMenuDefaultFields(newInput.initialEditedLayerId, newInput.colConfig)
// 		const defaultItemState = LayerFilterMenuPrt.getDefaultFilterMenuItemState(defaultFields, newInput.colConfig)
// 		get().filterMenu.setMenuItems(defaultItemState)
// 	}
// 	;(async () => {
// 		const states = await AppliedFiltersPrt.getInitialFilterStates(!!newInput.initialEditedLayerId)
// 		if (setupArgs.signal.aborted) return
// 		setupArgs.set({ appliedFilters: states })
// 	})()
// }

export const frame = frameManager.createFrame<Types>({
	name: 'selectLayers',
	setup,
	createKey: (frameId, input) => ({ frameId, editedLayerId: input.initialEditedLayerId, instanceId: input.instanceId }),
})

export namespace Sel {
	const EMPTY_LAYER_ITEMS = LQY.initLayerItemsState()

	// repeat rules are evaluated against the layers surrounding a position in the list, so without a cursor there's
	// nothing for them to say
	export function repeatRulesApplicable(state: State) {
		return state.cursor !== undefined
	}

	export function preMenuFilteredQueryInput(state: State, squadServer?: SquadServerFrame.State): LQY.BaseQueryInput {
		const appliedConstraints = AppliedFiltersPrt.Sel.constraints(state)

		// should generally not do this, but we're going to move this into frames anyway and it's low impact
		const settings = SquadServerFrame.Sel.settingsOrDefault(squadServer)

		const repeatRuleConstraints = PoolCheckboxesPrt.getToggledRepeatRuleConstraints(settings, state.poolCheckboxes.checkboxesState.dnr)

		// left unapplied so an unsupported layer is still listed, greyed out with the reason, rather than absent
		const installedMods = SETTINGS.getInstalledModsConstraint(settings, { applyAs: 'disabled' })

		return {
			cursor: state.cursor,
			action: state.initialEditedLayerId ? 'edit' : 'add',
			constraints: [installedMods, ...appliedConstraints, ...repeatRuleConstraints],
			list: squadServer?.layerItemsState ?? EMPTY_LAYER_ITEMS,
		}
	}

	export function baseQueryInput(state: State, squadServer: SquadServerFrame.State | undefined): LQY.BaseQueryInput {
		const preFiltered = preMenuFilteredQueryInput(state, squadServer)
		const filterMenuConstraints = LayerFilterMenuPrt.Sel.filterMenuConstraints(state)
		return LQY.mergeBaseInputs(preFiltered, { constraints: [...filterMenuConstraints, ...LayerSearchPrt.Sel.constraints(state)] })
	}
}

export namespace Actions {
	// keeps filtersOnlyCount up to date until the returned function is called
	export function watchFiltersOnlyCount(stores: KeyProp): () => void {
		const store = Zus.resolveStore<State>(stores.selectLayers)
		const adjust = (delta: number) =>
			store.setState((state) => ({ filtersOnlyCount: { ...state.filtersOnlyCount, watchers: state.filtersOnlyCount.watchers + delta } }))
		adjust(1)
		return () => adjust(-1)
	}

	export function setCursor(stores: KeyProp, cursor: LL.Cursor | undefined) {
		Zus.resolveStore<State>(stores.selectLayers).setState({ cursor })
	}
}

function getFilterMenuDefaultFields(
	editedLayerId: L.LayerId | undefined,
	colConfig: LQY.EffectiveColumnAndTableConfig,
	opts?: { keepCollection?: boolean },
) {
	let defaults: Partial<L.KnownLayer> = {}
	if (editedLayerId && colConfig) {
		const layer = L.toLayer(editedLayerId)
		if (layer.Gamemode === 'Training') {
			defaults = { Gamemode: 'Training', Collection: opts?.keepCollection ? layer.Collection : undefined }
		} else {
			defaults = Obj.omit(layer, ['Alliance_1', 'Alliance_2', 'id', 'Size'])
			// editing a layer should leave the rest of the catalog reachable, so only the focus action narrows to one collection
			if (!opts?.keepCollection) delete defaults.Collection
			for (const [key, value] of Obj.objEntries(defaults)) {
				if (value === undefined) continue
				const colDef = LC.getColumnDef(key)
				if (
					colDef?.type === 'string' &&
					colDef.enumMapping &&
					!LC.isEnumeratedValue(key, value as string, { ...CS.init(), effectiveColsConfig: colConfig })
				) {
					delete defaults[key]
				}
			}
		}
	}
	return defaults
}
