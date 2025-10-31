// this is very sparse at the moment, maybe we'll add more of these on-off flags later
import * as ZusUtils from '@/lib/zustand'
export type PoolCheckboxesState = {
	dnr: boolean
}

export type Store = {
	checkboxesState: PoolCheckboxesState
	setCheckbox: (type: keyof PoolCheckboxesState, value: boolean) => void
}

export function initNewPoolCheckboxes(defaultState: PoolCheckboxesState, set: ZusUtils.Setter<Store>) {
	set({
		checkboxesState: defaultState,
		setCheckbox(type, value) {
			set(state => ({ checkboxesState: { ...state.checkboxesState, [type]: value } }))
		},
	})
}
