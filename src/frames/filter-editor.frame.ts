import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { sleep } from '@/lib/async'
import * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as NodeMap from '@/lib/node-map'
import * as Obj from '@/lib/object'
import * as Sparse from '@/lib/sparse-tree'
import * as EFB from '@/models/editable-filter-builders'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as Im from 'immer'
import * as React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { frameManager, getFrameState, useFrameStore } from './frame-manager'

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
type FilterEditorBase =
	& {
		sub: Rx.Subscription

		editedFilterId?: string
		savedFilter: F.EditableFilterNode
		tree: F.FilterNodeTree

		validatedFilter: F.FilterNode | null
		modified: boolean
		valid: boolean

		// required for LayerTablePrt
		baseQueryInput: LQY.BaseQueryInput | undefined

		moveNode(sourcePath: Sparse.NodePath, targetPath: Sparse.NodePath): void
		updateRoot(filter: F.EditableFilterNode): void
		updateNode(id: string, cb: (draft: Im.Draft<F.ShallowEditableFilterNode>) => void): void
		deleteNode(id: string): void
		addChild(parentId: string, type: F.NodeType): void
		reset(filter?: F.EditableFilterNode): void

		nodeMapStore: Zus.StoreApi<NodeMap.NodeMapStore>
	}
	& F.NodeValidationErrorStore

export type FilterEditor =
	& {
		frameKey: Key
	}
	& FilterEditorBase
	& LayerTablePrt.Store

export type Key = FRM.InstanceKey<Types>

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

			validatedFilter: null,
			modified: false,
			valid: false,

			baseQueryInput: undefined,

			moveNode(sourcePath, targetPath) {
				set(state => {
					const tree = Obj.deepClone(state.tree)
					F.moveTreeNodeInPlace(tree, sourcePath, targetPath)
					return ({ tree })
				})
			},
			updateRoot(filter) {
				set({ tree: F.upsertFilterNodeTreeInPlace(filter) })
			},
			updateNode(id, update) {
				set({
					tree: Im.produce(get().tree, draft => {
						update(draft.nodes.get(id)!)
					}),
				})
			},
			deleteNode(id) {
				set({
					tree: Im.produce(get().tree, draft => {
						F.deleteTreeNode(draft, id)
					}),
				})
			},

			addChild(parentId, type) {
				set({
					tree: Im.produce(get().tree, draft => {
						const node: F.ShallowEditableFilterNode = F.toShallowNode(EFB.nodeOfType(type))
						const id = createId(4)
						const parentPath = draft.paths.get(parentId)!
						let last: number = -1
						for (const path of draft.paths.values()) {
							if (!Sparse.isChildPath(parentPath, path)) continue
							last = Math.max(last, path[parentPath.length])
						}

						const newPath = [...parentPath, last + 1]
						draft.paths.set(id, newPath)
						draft.nodes.set(id, node)
					}),
				})
			},
			reset(filter?: F.EditableFilterNode) {
				filter ??= get().savedFilter
				set({
					savedFilter: filter,
					tree: F.upsertFilterNodeTreeInPlace(filter),
				})
			},
			nodeMapStore: Zus.create<NodeMap.NodeMapStore>((set, get) => NodeMap.initNodeMap(get, set)),
		} satisfies FilterEditorBase,
	)

	function validate(state: FilterEditor) {
		const filter = F.treeToFilterNode(state.tree)
		const validatedFilter = F.isValidFilterNode(filter) ? filter : null
		set({
			validatedFilter: validatedFilter ?? null,
			baseQueryInput: validatedFilter ? LQY.getEditFilterPageInput(validatedFilter) : undefined,
			valid: validatedFilter !== null,
			modified: !Obj.deepEqual(filter, state.savedFilter),
		})
	}
	sleep(0).then(() => validate(get()))

	const validateSub = args.update$.pipe(
		Rx.debounceTime(150),
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

export function useNodePath(key: Key, id: string | undefined) {
	return useFrameStore(key, useShallow((s) => id ? s.tree.paths.get(id) : undefined))
}

export function useImmediateChildren(key: Key, id: string) {
	return useFrameStore(key, useShallow(s => F.resolveImmediateChildren(s.tree, id)))
}

export function selectNode(state: FilterEditor, id: string): F.ShallowEditableFilterNode {
	return state.tree.nodes.get(id)!
}

export function selectIdByPath(state: FilterEditor, path: Sparse.NodePath): string | undefined {
	return MapUtils.revLookup(state.tree.paths, path, Sparse.serializeNodePath)
}

export type CommonNodeActions = {
	delete(): void
	setNegation(negative: boolean): void
}

export type BlockNodeActions = {
	setBlockType: (type: F.BlockType) => void
	addChild: (type: F.NodeType) => void
}

export type CompNodeActions = {
	setComp: React.Dispatch<React.SetStateAction<F.EditableComparison>>
}

export type ApplyFilterNodeActions = {
	setFilterId: (filterId: F.FilterEntityId) => void
}

export type AllowMatchupsNodeActions = {
	setMasks: React.Dispatch<React.SetStateAction<F.FactionMask[][]>>
	setMode: React.Dispatch<React.SetStateAction<F.FactionMaskMode>>
}

export type NodeActions = {
	common: CommonNodeActions
	block: BlockNodeActions
	comp: CompNodeActions
	applyFilter: ApplyFilterNodeActions
	allowMatchups: AllowMatchupsNodeActions
}

type UpdateNodeFn = (cb: (draft: Im.Draft<F.ShallowEditableFilterNode>) => void) => void

export function getNodeActions(key: Key, id: string): NodeActions {
	const updateNode: UpdateNodeFn = (cb) => getFrameState(key).updateNode(id, (draft) => cb(draft))
	function getState() {
		return getFrameState(key)
	}

	return {
		common: {
			delete: () => getState().deleteNode(id),
			setNegation(neg: boolean) {
				updateNode(draft => {
					draft.neg = neg
				})
			},
		},
		block: {
			setBlockType(type) {
				updateNode(draft => {
					draft.type = type
				})
			},
			addChild: (type: F.NodeType) => {
				getFrameState(key).addChild(id, type)
			},
		},
		comp: {
			setComp(update) {
				updateNode(draft => {
					if (draft.type !== 'comp') return
					draft.comp = typeof update === 'function' ? update(draft.comp) : update
				})
			},
		},
		applyFilter: {
			setFilterId(filterId) {
				updateNode(draft => {
					if (draft.type !== 'apply-filter') return
					draft.filterId = filterId
				})
			},
		},
		allowMatchups: {
			setMasks(update) {
				updateNode(draft => {
					if (draft.type !== 'allow-matchups') return
					draft.allowMatchups.allMasks = typeof update === 'function' ? update(draft.allowMatchups.allMasks) : update
				})
			},
			setMode(update) {
				updateNode(draft => {
					if (draft.type !== 'allow-matchups') return
					draft.allowMatchups.mode = typeof update === 'function' ? update(draft.allowMatchups.mode ?? 'either') : update
				})
			},
		},
	}
}
