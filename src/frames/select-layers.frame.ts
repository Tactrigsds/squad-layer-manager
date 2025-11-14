import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as QD from '@/systems.client/queue-dashboard'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import { SJSHighlightRules } from 'ace-builds/src-noconflict/mode-sjs_highlight_rules'
import * as Im from 'immer'
import * as Rx from 'rxjs'
import { frameManager } from './frame-manager'

export type SelectType = 'generic' | 'indexed'
export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>

export function createInput(
	opts: {
		selected?: L.LayerId[]
		initialEditedLayerId?: L.LayerId
		cursor?: LQY.Cursor
		maxSelected?: number
		minSelected?: number
		sharedInstanceId?: string
	},
): Input {
	const base: BaseInput = {
		colConfig: ConfigClient.getColConfig(),
		initialEditedLayerId: opts.initialEditedLayerId,
		instanceId: opts.sharedInstanceId ?? createId(4),
		cursor: opts.cursor,
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

type BaseInput = { colConfig: LQY.EffectiveColumnAndTableConfig; cursor?: LQY.Cursor; initialEditedLayerId?: L.LayerId; instanceId: string }

type Input = BaseInput & LayerTablePrt.Input

type Primary = {
	setCursor: (cursor: LQY.Cursor | undefined) => void
	initialEditedLayerId?: L.LayerId
	cursor: LQY.Cursor | undefined
	input: Input
}

type Store =
	& Primary
	& AppliedFiltersPrt.State
	& PoolCheckboxesPrt.Store
	& LayerFilterMenuPrt.Store
	& LayerTablePrt.Store
	& LayerTablePrt.Predicates

export type Types = {
	name: 'selectLayers'
	key: FRM.RawInstanceKey<{ editedLayerId?: L.LayerId; instanceId: string }>
	input: Input
	state: Store
}

type Frame = FRM.Frame<Types>

const setup: Frame['setup'] = (args) => {
	const get = args.get
	const set = args.set
	const input = args.input
	// will never change
	const colConfig = input.colConfig

	set(
		{
			cursor: args.input.cursor,
			setCursor: (cursor) => {
				set({ cursor })
			},
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
				const state = get()
				state.filterMenu.setMenuItems(itemState)
			},
		} satisfies LayerTablePrt.Predicates,
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

	set({ baseQueryInput: selectBaseQueryInput(get()) })
	args.sub.add(
		args.update$.pipe(
			Rx.retry({ count: Infinity, delay: 1000 }),
		).subscribe(([state]) => {
			const baseQueryInput = selectBaseQueryInput(state)
			if (!Obj.deepEqual(baseQueryInput, get().baseQueryInput)) {
				set({ baseQueryInput: baseQueryInput })
			}
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

export function selectPreMenuFilteredQueryInput(state: Store): LQY.BaseQueryInput {
	const appliedConstraints = AppliedFiltersPrt.getAppliedFiltersConstraints(state)

	// should generally not do this, but we're going to move this into frames anyway and it's low impact
	const settings = ServerSettingsClient.Store.getState().saved

	const repeatRuleConstraints = QD.getToggledRepeatRuleConstraints(settings, state.checkboxesState.dnr)

	return {
		cursor: state.cursor,
		action: !!state.initialEditedLayerId ? 'edit' : 'add',
		constraints: [
			...appliedConstraints,
			...repeatRuleConstraints,
		],
	}
}

// "base" but it's stil after filter menu constraints have been applied
export function selectBaseQueryInput(state: Store) {
	const preFiltered = selectPreMenuFilteredQueryInput(state)
	const filterMenuConstraints = LayerFilterMenuPrt.selectFilterMenuConstraints(state)
	return LQY.mergeBaseInputs(preFiltered, { constraints: filterMenuConstraints })
}

export function selectMenuItemQueryInput(state: Store, field: string) {
	const preFiltered = selectPreMenuFilteredQueryInput(state)
	const itemConstraints = LayerFilterMenuPrt.selectFilterMenuItemConstraints(state, field)
	return LQY.mergeBaseInputs(preFiltered, { constraints: [...itemConstraints] })
}

// export function usePreMenuFilteredQueryInput(key: Key) {
// 	return useFrameStore(key, ZusUtils.useDeep(selectPreMenuFilteredQueryInput))
// }

// export function useMenuItemQueryInput(key: Key, field: string) {
// 	return useStore(key, ZusUtils.useDeep(state => selectMenuItemQueryInput(state, field)))
// }

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
					&& !LC.isEnumeratedValue(key, value as string, { effectiveColsConfig: colConfig })
				) {
					delete defaults[key]
				}
			}
		}
	}
	return defaults
}
