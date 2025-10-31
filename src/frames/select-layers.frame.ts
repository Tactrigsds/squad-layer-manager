import * as AppliedFiltersCtx from '@/frame-contexts/applied-filters'
import * as LayerFilterMenuCtx from '@/frame-contexts/layer-filter-menu'
import * as PoolCheckboxesCtx from '@/frame-contexts/pool-checkboxes'
import * as FR from '@/lib/frame'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as QD from '@/systems.client/queue-dashboard'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as Rx from 'rxjs'
import * as FrameStore from './store'

export type SelectType = 'generic' | 'indexed'

// don't export this. should call createKey
const KEY_PROP = Symbol('frameKey')
export type Key = { [KEY_PROP]: string | { itemId: LL.ItemId; action: LQY.LayerItemCursorAction } }
export function createKey(id: Key[typeof KEY_PROP]): Key {
	return { [KEY_PROP]: id }
}

type Input = { colConfig: LQY.EffectiveColumnAndTableConfig; cursor?: LQY.LayerQueryCursor; initialEditedLayerId?: L.LayerId }

type SelectState =
	& AppliedFiltersCtx.Store
	& PoolCheckboxesCtx.Store
	& LayerFilterMenuCtx.Store
	& {
		sub: Rx.Subscription
		setCursor: (cursor: LQY.LayerQueryCursor) => void
		initialEditedLayerId?: L.LayerId
		cursor?: LQY.LayerQueryCursor
		key: Key
	}

export type Types = {
	key: Key
	input: Input
	state: { selectLayers: SelectState[] }
	globalState: FrameStore.State
	startingState: FrameStore.State
}
{
	const _ = {} as Types satisfies FR.FrameTypes<FrameStore.State>
}

type Frame = FR.Frame<Types>

export const selectSelectState = ((state, key) => {
	return state.selectLayers.find(s => frame.keysEqual(s.key, key))!
}) satisfies FR.Selector<Types, SelectState>

const setup: Frame['setup'] = (key, input, store) => {
	console.log('setting up ', key)
	// const sub = new Rx.Subscription()
	const get: ZusUtils.Getter<SelectState> = () => {
		const state = (frame.store.getState() as Types['state']).selectLayers?.find(s => frame.keysEqual(s.key, key))
		if (!state) {
			frame.store.setState(state => ({ selectLayers: [...(state.selectLayers ?? []), { key }] }))
		}
		return selectSelectState(store.getState(), key)
	}
	const set: ZusUtils.Setter<SelectState> = (update) => {
		const selectState = get()
		const updatePartial = typeof update === 'function' ? update(selectState) : update
		const newSelectState = { ...selectState, ...updatePartial }
		store.setState(state => ({ selectLayers: state.selectLayers.map(s => frame.keysEqual(s.key, key) ? newSelectState : s) }))
	}

	store.setState({
		selectLayers: [
			...(store.getState().selectLayers ?? []),
		],
	})
	set({
		key: Obj.selectProps(key, [KEY_PROP]),
		sub: new Rx.Subscription(),
		cursor: input.cursor,
		setCursor: (cursor: LQY.LayerQueryCursor) => {
			set({ cursor })
		},
		initialEditedLayerId: input.initialEditedLayerId,
	})

	AppliedFiltersCtx.initAppliedFiltersStore(get, set, !!input.initialEditedLayerId)
	PoolCheckboxesCtx.initNewPoolCheckboxes({ dnr: !input.initialEditedLayerId }, set)
	LayerFilterMenuCtx.initLayerFilterMenuStore(
		get,
		set,
		input.colConfig,
		getFilterMenuDefaults(input?.initialEditedLayerId, input.colConfig),
	)
	return store.getState()
}

const teardown: Frame['teardown'] = (globalState, key, setTeardown) => {
	const state = selectSelectState(globalState, key)
	if (!state) debugger
	state.sub.unsubscribe()
	setTeardown({ selectLayers: undefined })
}

const keysEqual = (a: Key, b: Key) => Obj.deepEqual(a[KEY_PROP], b[KEY_PROP])

export const frame = FR.create<Types>({
	store: FrameStore.FrameStore,
	exists: (state, key) => Boolean((state as Partial<Types['state']>)?.selectLayers?.find(f => keysEqual(f.key, key))),
	setup,
	teardown,
	keysEqual,
})

export function useFrameExists(key: Key) {
	return FR.useFrameExists(frame, key)
}

export function useSelectLayersState(key: Key) {
	return FR.useExistingFrameState<Types, SelectState>(frame, key, s => {
		return selectSelectState(s, key)
	})
}

type SelectLayersSelector<T> = (state: SelectState) => T
export function useSelectedSelectLayersState<T>(key: Key, selector: SelectLayersSelector<T>) {
	return FR.useExistingFrameState<Types, T>(frame, key, s => {
		return selector(selectSelectState(s, key))
	})
}

export function selectPreMenuFilteredQueryInput(state: SelectState): LQY.BaseQueryInput {
	const appliedConstraints = AppliedFiltersCtx.getAppliedFiltersConstraints(state)

	// should generally not do this, but we're going to move this into frames anyway and it's low impact
	const settings = ServerSettingsClient.Store.getState().saved

	const repeatRuleConstraints = QD.getToggledRepeatRuleConstraints(settings, state.checkboxesState.dnr)

	return {
		cursor: state.cursor,
		constraints: [
			...appliedConstraints,
			...repeatRuleConstraints,
		],
	}
}

export function selectQueryInput(state: SelectState) {
	const preFiltered = selectPreMenuFilteredQueryInput(state)
	const filterMenuConstraints = LayerFilterMenuCtx.selectFilterMenuConstraints(state)
	return LQY.mergeBaseInputs(preFiltered, { constraints: filterMenuConstraints })
}

export function selectMenuItemQueryInput(state: SelectState, field: string) {
	const preFiltered = selectPreMenuFilteredQueryInput(state)
	const itemConstraints = LayerFilterMenuCtx.selectFilterMenuItemConstraints(state, field)
	return LQY.mergeBaseInputs(preFiltered, { constraints: [...itemConstraints] })
}

export function useQueryInput(key: Key) {
	return useSelectedSelectLayersState(key, ZusUtils.useDeep(selectQueryInput))
}

export function usePreMenuFilteredQueryInput(key: Key) {
	return useSelectedSelectLayersState(key, ZusUtils.useDeep(selectPreMenuFilteredQueryInput))
}

export function useMenuItemQueryInput(key: Key, field: string) {
	return useSelectedSelectLayersState(key, ZusUtils.useDeep(state => selectMenuItemQueryInput(state, field)))
}

export const getState = (key: Key) => {
	const state = frame.store.getState()
	if (!frame.exists(state, key)) throw new Error('SelectLayersFrame does not exist')
	return selectSelectState(state as Types['state'], key)
}

export const exists = (key: Key) => {
	const state = frame.store.getState()
	return frame.exists(state, key)
}

function getFilterMenuDefaults(editedLayerId: L.LayerId | undefined, colConfig: LQY.EffectiveColumnAndTableConfig) {
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
