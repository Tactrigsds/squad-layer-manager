import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { sleep } from '@/lib/async'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as NodeMap from '@/lib/node-map'
import * as Obj from '@/lib/object'
import * as Sparse from '@/lib/sparse-tree'
import * as ZusUtils from '@/lib/zustand'
import * as EFB from '@/models/editable-filter-builders'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as Im from 'immer'
import * as React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { frameManager } from './frame-manager'

type Input = {
	editedFilterId?: string
	startingFilter?: F.EditableFilterNode
	instanceId: string
} & LayerTablePrt.Input

export const createInput = (
	args: { editedFilterId?: string; startingFilter?: F.EditableFilterNode; colConfig: LQY.EffectiveColumnAndTableConfig },
): Input => {
	return {
		editedFilterId: args.editedFilterId,
		startingFilter: args.startingFilter,
		...LayerTablePrt.getInputDefaults({ colConfig: args.colConfig }),
		instanceId: createId(4),
	}
}
// one-shot intent recorded when a node is added from the categorized add menu, keyed by the new node's
// id. `group` scopes a comparison's subject dropdown while it is still blank (it is otherwise re-derived
// from the chosen column); `focus`/`autoOpenLayers` are consumed once on mount.
export type CreateHint = {
	group?: F.SubjectColumnGroup
	focus?: 'operator'
	autoOpenLayers?: boolean
}

type FilterEditorBase =
	& {
		sub: Rx.Subscription

		editedFilterId?: string
		savedFilter: F.EditableFilterNode
		tree: F.FilterNodeTree
		createHints: Map<string, CreateHint>

		validatedFilter: F.FilterNode | null
		modified: boolean
		valid: boolean

		nodeMapStore: Zus.StoreApi<NodeMap.NodeMapStore>
	}
	& F.NodeValidationErrorStore
	& LayerTablePrt.Predicates

export type FilterEditor =
	& {
		frameKey: Key
	}
	& FilterEditorBase
	& LayerTablePrt.Store

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>

export type Types = {
	name: 'filterEditor'
	key: FRM.RawInstanceKey<{ editedFilterId?: string }>
	//
	input: Input
	state: FilterEditor
}

export type Frame = FRM.Frame<Types>

const setup: Frame['setup'] = (args) => {
	const get = args.get
	const set = args.set

	const editedFilterEntity = args.input.editedFilterId ? FilterEntityClient.filterEntities.get(args.input.editedFilterId) : null
	const savedFilter: F.EditableFilterNode = args.input.startingFilter ?? editedFilterEntity?.filter ?? EFB.and()

	set(
		{
			sub: new Rx.Subscription(),

			errors: [],
			setErrors: (errors) => set({ errors }),

			savedFilter: savedFilter,
			tree: F.upsertFilterNodeTreeInPlace(savedFilter),
			createHints: new Map(),

			validatedFilter: null,
			modified: false,
			valid: false,

			baseQueryInput: undefined,

			nodeMapStore: Zus.create<NodeMap.NodeMapStore>((set, get) => NodeMap.initNodeMap(get, set)),
		} satisfies FilterEditorBase,
	)

	function validate(state: FilterEditor) {
		const filter = F.treeToFilterNode(state.tree)
		const validatedFilter = F.isValidFilterNode(filter) ? filter : null
		const baseQueryInput = validatedFilter ? Obj.deepClone(LQY.getEditFilterPageBaseInput(validatedFilter)) : undefined
		set({
			validatedFilter: validatedFilter ?? null,
			baseQueryInput,
			valid: validatedFilter !== null,
			modified: !Obj.deepEqual(filter, state.savedFilter),
		})
	}
	void sleep(0).then(() => validate(get()))

	const validateSub = args.update$.pipe(
		Rx.throttleTime(150, Rx.asyncScheduler, { leading: true, trailing: true }),
		Rx.retry(),
	).subscribe(([state, prev]) => {
		if (state.tree !== prev.tree) {
			validate(state)
		}
	})
	get().sub.add(validateSub)

	LayerTablePrt.initLayerTable(args)
}

export const frame = frameManager.createFrame<Types>({
	name: 'filterEditor',
	setup,
	createKey: (frameId, input) => ({ frameId, editedFilterId: input.editedFilterId, instanceId: input.instanceId }),
})

export namespace Sel {
	export const nodePath = (id: string | undefined) => (state: FilterEditor) => id ? state.tree.paths.get(id) : undefined

	export const immediateChildren = (id: string) => (state: FilterEditor) => F.resolveImmediateChildren(state.tree, id)

	export const node = (id: string) => (state: FilterEditor): F.ShallowEditableFilterNode => state.tree.nodes.get(id)!

	export const idByPath = (path: Sparse.NodePath) => (state: FilterEditor): string | undefined =>
		MapUtils.revLookup(state.tree.paths, path, Sparse.serializeNodePath)

	export const createHint = (id: string) => (state: FilterEditor): CreateHint | undefined => state.createHints.get(id)
}

export type CommonNodeActions = {
	delete(): void
}

export type BlockNodeActions = {
	setBlockType: (type: F.BlockType) => void
	addChild: (type: F.NodeType) => void
	addSeeded: (seed: F.EditableFilterNode, hint?: CreateHint) => void
}

export type CompNodeActions = {
	setNode: React.Dispatch<React.SetStateAction<F.EditableCompNode>>
}

export type ApplyFilterNodeActions = {
	setType: (type: F.ApplyFilterType) => void
	setFilterId: (filterId: F.FilterEntityId) => void
}

export type MatchupNodeActions = {
	setType: (type: F.MatchupType) => void
	setLocked: (locked: boolean) => void
	swapTeams: () => void
	setTeamValues: (teamIndex: 0 | 1, column: F.TeamColumn, values: F.Value[]) => void
}

export type NodeActions = {
	common: CommonNodeActions
	block: BlockNodeActions
	comp: CompNodeActions
	applyFilter: ApplyFilterNodeActions
	matchup: MatchupNodeActions
}

type UpdateNodeFn = (cb: (draft: Im.Draft<F.ShallowEditableFilterNode>) => void) => void

export namespace Actions {
	function store(stores: KeyProp) {
		return ZusUtils.resolveStore<FilterEditor>(stores.filterEditor)
	}

	export function moveNode(stores: KeyProp, sourcePath: Sparse.NodePath, targetPath: Sparse.NodePath) {
		store(stores).setState(state => {
			const tree = Obj.deepClone(state.tree)
			F.moveTreeNodeInPlace(tree, sourcePath, targetPath)
			return ({ tree })
		})
	}

	export function updateRoot(stores: KeyProp, filter: F.EditableFilterNode) {
		store(stores).setState({ tree: F.upsertFilterNodeTreeInPlace(filter), createHints: new Map() })
	}

	export function updateNode(stores: KeyProp, id: string, cb: (draft: Im.Draft<F.ShallowEditableFilterNode>) => void) {
		const s = store(stores)
		s.setState({
			tree: Im.produce(s.getState().tree, draft => {
				cb(draft.nodes.get(id)!)
			}),
		})
	}

	export function deleteNode(stores: KeyProp, id: string) {
		const s = store(stores)
		s.setState({
			tree: Im.produce(s.getState().tree, draft => {
				F.deleteTreeNode(draft, id)
			}),
		})
	}

	export function addChild(stores: KeyProp, parentId: string, type: F.NodeType) {
		addSeededChild(stores, parentId, EFB.nodeOfType(type))
	}

	export function addSeededChild(stores: KeyProp, parentId: string, seed: F.EditableFilterNode, hint?: CreateHint) {
		const s = store(stores)
		const id = createId(4)
		const tree = Im.produce(s.getState().tree, draft => {
			const node: F.ShallowEditableFilterNode = F.toShallowNode(seed)
			const parentPath = draft.paths.get(parentId)!
			let last: number = -1
			for (const path of draft.paths.values()) {
				if (!Sparse.isChildPath(parentPath, path)) continue
				last = Math.max(last, path[parentPath.length])
			}

			const newPath = [...parentPath, last + 1]
			draft.paths.set(id, newPath)
			draft.nodes.set(id, node)
		})
		if (hint) s.setState({ tree, createHints: new Map(s.getState().createHints).set(id, hint) })
		else s.setState({ tree })
	}

	export function reset(stores: KeyProp, filter?: F.EditableFilterNode) {
		const s = store(stores)
		filter ??= s.getState().savedFilter
		s.setState({
			savedFilter: filter,
			tree: F.upsertFilterNodeTreeInPlace(filter),
			createHints: new Map(),
		})
	}
}

export function getNodeActions(stores: KeyProp, id: string): NodeActions {
	const updateNode: UpdateNodeFn = (cb) => Actions.updateNode(stores, id, (draft) => cb(draft))

	return {
		common: {
			delete: () => Actions.deleteNode(stores, id),
		},
		block: {
			setBlockType(type) {
				updateNode(draft => {
					draft.type = type
				})
			},
			addChild: (type: F.NodeType) => {
				Actions.addChild(stores, id, type)
			},
			addSeeded: (seed, hint) => {
				Actions.addSeededChild(stores, id, seed, hint)
			},
		},
		comp: {
			setNode(update) {
				updateNode(draft => {
					if (!F.isCompNode(draft)) return
					const next = typeof update === 'function' ? update(draft as F.EditableCompNode) : update
					// replace whole node contents (args count varies by operator), keeping only the new keys
					for (const key of Object.keys(draft)) {
						if (!(key in next)) delete (draft as any)[key]
					}
					Object.assign(draft, next)
				})
			},
		},
		applyFilter: {
			setType(type) {
				updateNode(draft => {
					if (!F.isApplyFilterNode(draft)) return
					draft.type = type
				})
			},
			setFilterId(filterId) {
				updateNode(draft => {
					if (!F.isApplyFilterNode(draft)) return
					draft.filterId = filterId
				})
			},
		},
		matchup: {
			setType(type) {
				updateNode(draft => {
					if (!F.isMatchupNode(draft)) return
					draft.type = type
				})
			},
			setLocked(locked) {
				updateNode(draft => {
					if (!F.isMatchupNode(draft)) return
					draft.locked = locked
				})
			},
			swapTeams() {
				updateNode(draft => {
					if (!F.isMatchupNode(draft)) return
					draft.teams = [draft.teams[1], draft.teams[0]]
				})
			},
			setTeamValues(teamIndex, column, values) {
				updateNode(draft => {
					if (!F.isMatchupNode(draft)) return
					// an empty dimension means "any"; drop the key rather than storing [] so the two spell
					// the same thing in persisted filters
					if (values.length === 0) delete draft.teams[teamIndex][column]
					else draft.teams[teamIndex][column] = values
				})
			},
		},
	}
}
