import { atom } from 'jotai'

import * as M from './models'

const defaultFilter: M.EditableFilterNode = {
	type: 'and',
	children: [],
}

export const pageIndexAtom = atom(0)
export const lastValidFilterAtom = atom(null as M.FilterNode | null)
const _editableFilterAtom = atom(defaultFilter as M.EditableFilterNode)
export const editableFilterAtom = atom(
	(get) => get(_editableFilterAtom),
	(get, set, update: (f: M.EditableFilterNode) => M.EditableFilterNode) => {
		const newFilter = update(get(_editableFilterAtom))
		if (newFilter.type === 'and' && newFilter.children.length === 0) {
			set(lastValidFilterAtom, null)
		} else if (M.isValidFilterNode(newFilter)) {
			set(lastValidFilterAtom, newFilter)
		}
		set(pageIndexAtom, 0)
		set(_editableFilterAtom, newFilter)
	}
)
