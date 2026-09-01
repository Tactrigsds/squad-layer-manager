import * as Im from 'immer'

import type * as FRM from '@/lib/frame'
import * as Zus from '@/lib/zustand'
import * as HQ from '@/models/history.models'

import { frameManager } from './frame-manager'

// The history page's draft state: the query being edited, as against the executed one, which lives in the
// url. Running writes the draft to the url; loading a saved or recent query is just a navigation, which
// mints a fresh instance seeded from the new url.

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>
export type Input = { initial: HQ.Query }
export type Types = {
	name: 'history'
	key: FRM.RawInstanceKey<{ initial: HQ.Query }>
	input: Input
	state: Store
}

// steps down the tree: a block child by index, a subquery's filter by 'f'
export type Path = (number | 'f')[]

export type Store = {
	draft: HQ.Query
	// the advanced tree, kept alongside the draft's basic fields so switching modes loses nothing
	tree: HQ.EditableNode
	// bumped on every structural change to the tree, so the editor's uncontrolled inputs remount rather than
	// leaving a removed node's text behind on the sibling that shifted into its place
	revision: number
}

function seedTree(query: HQ.Query): HQ.EditableNode {
	return HQ.queryFilterNode(query) as HQ.EditableNode
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'history',
	createKey: (frameId, input) => ({ frameId, initial: input.initial }),
	setup(args) {
		args.set({ draft: args.input.initial, tree: seedTree(args.input.initial), revision: 0 } satisfies Store)
	},
})

function nodeAt(root: HQ.EditableNode, path: Path): HQ.EditableNode {
	let node = root
	for (const step of path) {
		if (step === 'f') node = (node as HQ.EditableSubqueryNode).filter
		else node = (node as Extract<HQ.EditableNode, { children: unknown }>).children[step]
	}
	return node
}

export namespace Sel {
	export function builtQuery(state: Store): HQ.Query {
		if (state.draft.mode !== 'advanced') return { ...state.draft, q: undefined }
		return { ...state.draft, q: HQ.isValidNode(state.tree) ? state.tree : undefined }
	}

	export function canRun(state: Store): boolean {
		return state.draft.mode !== 'advanced' || HQ.isValidNode(state.tree)
	}
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<Store>(stores.history)
	}

	export function setDraft(stores: KeyProp, patch: Partial<HQ.Query>) {
		const s = store(stores)
		s.setState({ draft: { ...s.getState().draft, ...patch } })
	}

	export function setMode(stores: KeyProp, mode: HQ.Query['mode']) {
		const s = store(stores)
		const state = s.getState()
		if (state.draft.mode === mode) return
		if (mode === 'advanced') {
			// seed the tree from the basic fields, so the switch shows the same query in tree form
			s.setState({
				draft: { ...state.draft, mode },
				tree: seedTree({ ...state.draft, mode: 'basic' }),
				revision: state.revision + 1,
			})
		} else {
			s.setState({ draft: { ...state.draft, mode } })
		}
	}

	export function updateNode(stores: KeyProp, path: Path, update: (node: HQ.EditableNode) => void) {
		const s = store(stores)
		s.setState({ tree: Im.produce(s.getState().tree, (tree) => update(nodeAt(tree, path))) })
	}

	export function replaceNode(stores: KeyProp, path: Path, node: HQ.EditableNode) {
		const s = store(stores)
		if (path.length === 0) {
			s.setState({ tree: node, revision: s.getState().revision + 1 })
			return
		}
		s.setState({
			revision: s.getState().revision + 1,
			tree: Im.produce(s.getState().tree, (tree) => {
				const parent = nodeAt(tree, path.slice(0, -1))
				const last = path[path.length - 1]
				if (last === 'f') (parent as HQ.EditableSubqueryNode).filter = node
				else (parent as Extract<HQ.EditableNode, { children: unknown }>).children[last] = node
			}),
		})
	}

	export function addChild(stores: KeyProp, blockPath: Path, node: HQ.EditableNode) {
		updateNode(stores, blockPath, (block) => {
			;(block as Extract<HQ.EditableNode, { children: unknown }>).children.push(node)
		})
		store(stores).setState((prev) => ({ revision: prev.revision + 1 }))
	}

	export function removeNode(stores: KeyProp, path: Path) {
		const s = store(stores)
		const last = path[path.length - 1]
		if (typeof last !== 'number') return
		s.setState({
			revision: s.getState().revision + 1,
			tree: Im.produce(s.getState().tree, (tree) => {
				const parent = nodeAt(tree, path.slice(0, -1))
				;(parent as Extract<HQ.EditableNode, { children: unknown }>).children.splice(last, 1)
			}),
		})
	}
}
