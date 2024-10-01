import { atom } from 'jotai'

import * as M from './models'

const defaultFilter: M.EditableFilterNode = {
	type: 'and',
	children: [],
}

export const pageIndexAtom = atom(0)
export const lastValidFilterAtom = atom(defaultFilter as M.FilterNode | null)
export const editableFilterAtom = atom(defaultFilter, (get, set, update: (f: M.EditableFilterNode) => M.EditableFilterNode) => {
	const newFilter = update(get(editableFilterAtom))
	if (newFilter.type === 'and' && newFilter.children.length === 0) {
		set(lastValidFilterAtom, null)
	} else if (M.isValidFilterNode(newFilter)) {
		set(lastValidFilterAtom, newFilter)
	} else {
		console.warn('Invalid filter:', newFilter)
	}
	set(pageIndexAtom, 0)
	return newFilter
})
