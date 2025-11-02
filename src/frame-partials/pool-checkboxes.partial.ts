// this is very sparse at the moment, maybe we'll add more of these on-off flags later
import * as FRM from '@/lib/frame'
import * as ZusUtils from '@/lib/zustand'
export type PoolCheckboxesState = {
	dnr: boolean
}

export type Store = {
	checkboxesState: PoolCheckboxesState
	setCheckbox: (type: keyof PoolCheckboxesState, value: boolean) => void
}
type Args = FRM.SetupArgs<{ defaultState: PoolCheckboxesState }, Store>

export function initNewPoolCheckboxes(args: Args) {
	const { set } = args
	const defaultState = args.input.defaultState
	set({
		checkboxesState: defaultState,
		setCheckbox(type, value) {
			set(state => ({ checkboxesState: { ...state.checkboxesState, [type]: value } }))
		},
	})
}
