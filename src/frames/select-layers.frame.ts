import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { distinctDeepEquals } from '@/lib/async'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import * as ConfigClient from '@/systems/config.client'
import { layerItemsState$ } from '@/systems/layer-queue.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as Rx from 'rxjs'
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
	} & Partial<SquadServerFrame.KeyProp>,
): Input {
	const base: BaseInput = {
		colConfig: ConfigClient.getColConfig(),
		initialEditedLayerId: opts.initialEditedLayerId,
		instanceId: opts.sharedInstanceId ?? createId(4),
		cursor: opts.cursor,
		squadServer: opts.squadServer,
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
} & Partial<SquadServerFrame.KeyProp>

type Input = BaseInput & LayerTablePrt.Input

type Primary = {
	initialEditedLayerId?: L.LayerId
	cursor: LL.Cursor | undefined
	input: Input
}

type State =
	& Primary
	& AppliedFiltersPrt.Store
	& PoolCheckboxesPrt.Store
	& LayerFilterMenuPrt.Store
	& LayerTablePrt.Store
	& LayerTablePrt.Predicates
	//  setup for this is handled by the layer table partial
	& LayerFilterMenuPrt.Predicates

export type Types = {
	name: 'selectLayers'
	key: FRM.RawInstanceKey<{ editedLayerId?: L.LayerId; instanceId: string }>
	input: Input
	state: State
}

type Frame = FRM.Frame<Types>

const setup: Frame['setup'] = (args) => {
	const get = args.get
	const set = args.set
	const input = args.input
	const colConfig = input.colConfig

	set(
		{
			cursor: args.input.cursor,
			input,
			initialEditedLayerId: args.input.initialEditedLayerId,
		} satisfies Primary,
	)

	set(
		{
			baseQueryInput: undefined,
			onLayerFocused: (layerId) => {
				const defaultFields = getFilterMenuDefaultFields(layerId, colConfig)
				const itemState = LayerFilterMenuPrt.getDefaultFilterMenuItemState(defaultFields, colConfig)
				LayerFilterMenuPrt.Actions.setMenuItems({ filterMenu: args.key }, itemState)
			},
		} satisfies LayerTablePrt.Predicates,
	)

	set(
		{
			resetAllConstraints() {
				LayerFilterMenuPrt.Actions.resetAllFilters({ filterMenu: args.key })
				PoolCheckboxesPrt.Actions.setCheckbox({ poolCheckboxes: args.key }, 'dnr', 'disabled')
				AppliedFiltersPrt.Actions.disableAllAppliedFilters({ appliedFilters: args.key })
			},
		} satisfies LayerFilterMenuPrt.Predicates,
	)

	AppliedFiltersPrt.initAppliedFiltersStore({
		...args,
		input: { poolDefaultDisabled: !!input.initialEditedLayerId },
	})
	PoolCheckboxesPrt.initNewPoolCheckboxes({ ...args, input: { defaultState: { dnr: 'disabled' } } })
	LayerFilterMenuPrt.initLayerFilterMenuStore({
		...args,
		input: { colConfig: input.colConfig, defaultFields: getFilterMenuDefaultFields(input.initialEditedLayerId, input.colConfig) },
	})
	LayerTablePrt.initLayerTable(args)

	let baseQueryInput$: Rx.Observable<LQY.BaseQueryInput>

	if (input.squadServer) {
		baseQueryInput$ = Rx.combineLatest([
			args.update$,
			ZusUtils.toObservable(input.squadServer, true),
		]).pipe(Rx.map(([[state], [squadServer]]) => {
			return Sel.baseQueryInput(state, squadServer)
		}))
	} else {
		baseQueryInput$ = args.update$.pipe(Rx.map(([state]) => Sel.baseQueryInput(state, undefined)))
	}
	args.sub.add(
		baseQueryInput$.pipe(
			Rx.retry({ count: Infinity, delay: 1000 }),
			distinctDeepEquals(),
		).subscribe((baseQueryInput) => {
			set({ baseQueryInput })
		}),
	)
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
// 		if (setupArgs.sub.closed) return
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

	export function preMenuFilteredQueryInput(
		state: State,
		squadServer?: SquadServerFrame.State,
	): LQY.BaseQueryInput {
		const appliedConstraints = AppliedFiltersPrt.Sel.constraints(state)

		// should generally not do this, but we're going to move this into frames anyway and it's low impact
		const settings = SquadServerFrame.Sel.settingsOrDefault(squadServer)

		const repeatRuleConstraints = PoolCheckboxesPrt.getToggledRepeatRuleConstraints(settings, state.poolCheckboxes.checkboxesState.dnr)

		return {
			cursor: state.cursor,
			action: state.initialEditedLayerId ? 'edit' : 'add',
			constraints: [
				...appliedConstraints,
				...repeatRuleConstraints,
			],
			list: squadServer?.layerItemsState ?? EMPTY_LAYER_ITEMS,
		}
	}

	export function baseQueryInput(state: State, squadServer: SquadServerFrame.State | undefined): LQY.BaseQueryInput {
		const preFiltered = preMenuFilteredQueryInput(state, squadServer)
		const filterMenuConstraints = LayerFilterMenuPrt.Sel.filterMenuConstraints(state)
		return LQY.mergeBaseInputs(preFiltered, { constraints: filterMenuConstraints })
	}
}

export namespace Actions {
	export function setCursor(stores: KeyProp, cursor: LL.Cursor | undefined) {
		ZusUtils.resolveStore<State>(stores.selectLayers).setState({ cursor })
	}
}

function getFilterMenuDefaultFields(editedLayerId: L.LayerId | undefined, colConfig: LQY.EffectiveColumnAndTableConfig) {
	let defaults: Partial<L.KnownLayer> = {}
	if (editedLayerId && colConfig) {
		const layer = L.toLayer(editedLayerId)
		if (layer.Gamemode === 'Training') {
			defaults = { Gamemode: 'Training' }
		} else {
			defaults = Obj.exclude(layer, ['Alliance_1', 'Alliance_2', 'id', 'Size'])
			for (const [key, value] of Obj.objEntries(defaults)) {
				if (value === undefined) continue
				const colDef = LC.getColumnDef(key)
				if (
					colDef?.type === 'string' && colDef.enumMapping
					&& !LC.isEnumeratedValue(key, value as string, { ...CS.init(), effectiveColsConfig: colConfig })
				) {
					delete defaults[key]
				}
			}
		}
	}
	return defaults
}
