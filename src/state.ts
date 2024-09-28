import { produce } from 'immer'
import { atom } from 'jotai'
import { useSetImmerAtom } from 'jotai-immer'

import * as M from './models'

const defaultFilter: M.FilterNode = {
	type: 'and',
	children: [{ type: 'comp', comp: { code: 'eq', column: 'Level', value: 'AlBasrah' } }],
}
export const filterAtom = atom(defaultFilter)

export function useFilterNode(path: number[]) {
	const setFilter = useSetImmerAtom(filterAtom)

	return (value: M.FilterNode) => {
		setFilter((draft) => {
			if (path.length === 0) return value
			let current = draft as M.FilterNode
			for (let i = 0; i < path.length - 1; i++) {
				current = current.children![path[i]]
			}
			current.children![path[path.length - 1]] = value
		})
	}
}

export function useSetComparison<C extends M.Comparison>(path: number[]) {
	const [node, setNode] = useFilterNode(path)

	return (value: M.Comparison) => {
		setNode(
			produce(value, (draft) => {
				const comp = node.comp
			})
		)
	}
}
