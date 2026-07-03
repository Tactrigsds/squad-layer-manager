// this is very sparse at the moment, maybe we'll add more of these on-off flags later
import type * as FRM from '@/lib/frame'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import type * as LQY from '@/models/layer-queries.models'
import * as SETTINGS from '@/models/settings.models'
export type PoolCheckboxesState = {
	dnr: SETTINGS.PoolFilterApplyAs
}

export type Store = {
	poolCheckboxes: PoolCheckboxesSlice
}

export type PoolCheckboxesSlice = {
	checkboxesState: PoolCheckboxesState
}

type Args = FRM.SetupArgs<{ defaultState: PoolCheckboxesState }, Store>
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { poolCheckboxes: Key }

export function initNewPoolCheckboxes(args: Args) {
	const set = ZusUtils.toPartialSetter(args.set, 'poolCheckboxes')
	const defaultState = args.input.defaultState
	set(
		{
			checkboxesState: defaultState,
		} satisfies PoolCheckboxesSlice,
	)
}

export namespace Sel {
	export function checkboxesState(store: Store) {
		return store.poolCheckboxes.checkboxesState
	}
}

export namespace Actions {
	export function setCheckbox(stores: KeyProp, type: keyof PoolCheckboxesState, value: SETTINGS.PoolFilterApplyAs) {
		ZusUtils.toPartialStore(stores.poolCheckboxes, 'poolCheckboxes').setState(state => ({
			checkboxesState: { ...state.checkboxesState, [type]: value },
		}))
	}
}

export function getToggledRepeatRuleConstraints(settings: SETTINGS.PublicServerSettings, applyAs: SETTINGS.PoolFilterApplyAs) {
	const dnrConstraints: LQY.Constraint[] = []
	const repeatRules = settings.queue.mainPool.repeatRules
	for (let i = 0; i < repeatRules.length; i++) {
		const rule = repeatRules[i]
		dnrConstraints.push(
			CB.repeatRule(SETTINGS.getRepeatRuleConstraintId('mainPool', rule), rule, { filterApplState: applyAs, warn: rule.warn }),
		)
	}
	return dnrConstraints
}
