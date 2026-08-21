import * as Im from 'immer'
import * as React from 'react'

import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map-utils'
import * as NodeMap from '@/lib/node-map'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import * as Sparse from '@/lib/sparse-tree'
import * as Zus from '@/lib/zustand'
import * as EFB from '@/models/editable-filter-builders'
import * as FE from '@/models/filter-edit.models'
import * as FR from '@/models/filter-references.models'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import type * as UP from '@/models/user-presence'
import * as FilterEditClient from '@/systems/filter-edit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

import { frameManager } from './frame-manager'

type Input = {
	editedFilterId?: string
	startingFilter?: F.EditableFilterNode
	instanceId: string
} & LayerTablePrt.Input

export const createInput = (args: {
	editedFilterId?: string
	startingFilter?: F.EditableFilterNode
	colConfig: LQY.EffectiveColumnAndTableConfig
}): Input => {
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
	focus?: 'operator' | 'values'
	autoOpenLayers?: boolean
}

type FilterEditorBase = {
	editedFilterId?: string
	// the shared draft this editor is a replica of. A filter that has not been created yet has no entity to
	// share, so its session stays local and its ops are never sent (see dispatch).
	session: ODSM.Client.Session<FE.Op, FE.State>
	shared: boolean
	tree: F.FilterNodeTree
	meta: FE.Meta
	presenceEvent$: Rx.Subject<UP.PresenceEvent>
	createHints: Map<string, CreateHint>
	// nodes whose comment is open for editing rather than displayed
	editedComments: Set<string>

	validatedFilter: F.FilterNode | null
	// the apply-filter loop this edit would create, if any. A loop has no fixed point once the referenced
	// filters are inlined, so the server refuses to store one and saving is blocked here first.
	referenceCycle: F.FilterEntityId[] | null
	modified: boolean
	valid: boolean

	nodeMapStore: Zus.StoreApi<NodeMap.NodeMapStore>
} & F.NodeValidationErrorStore &
	LayerTablePrt.Predicates

export type FilterEditor = {
	frameKey: Key
} & FilterEditorBase &
	LayerTablePrt.Store

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

// the loop the edited tree would close against the filters as they are currently stored
function findCycle(editedFilterId: F.FilterEntityId, filter: F.FilterNode) {
	const entities = Array.from(FilterEntityClient.filterEntities.values())
	const edited = entities.find((e) => e.id === editedFilterId)
	if (!edited) return null
	return FR.findCycle(
		entities.map((e) => (e.id === editedFilterId ? { ...e, filter } : e)),
		editedFilterId,
	)
}

const setup: Frame['setup'] = (args) => {
	const get = args.get
	const set = args.set

	const filterId = args.input.editedFilterId
	const editedFilterEntity = filterId ? FilterEntityClient.filterEntities.get(filterId) : null
	const startingFilter: F.EditableFilterNode = args.input.startingFilter ?? editedFilterEntity?.filter ?? EFB.and()
	// a placeholder until the server's init snapshot lands; for a filter that doesn't exist yet it is the
	// whole session
	const session = ODSM.Client.initSession<FE.Op, FE.State>(FE.localState(filterId ?? '', startingFilter, editedFilterEntity ?? undefined))
	const presenceEvent$ = new Rx.Subject<UP.PresenceEvent>()
	args.cleanup.push(presenceEvent$)

	set({
		errors: [],
		setErrors: (errors) => set({ errors }),

		editedFilterId: filterId,
		session,
		shared: !!filterId,
		tree: session.localState.draft.tree,
		meta: session.localState.draft.meta,
		presenceEvent$,
		createHints: new Map(),
		editedComments: new Set(),

		validatedFilter: null,
		referenceCycle: null,
		modified: false,
		valid: false,

		baseQueryInput: undefined,

		nodeMapStore: Zus.create<NodeMap.NodeMapStore>((set, get) => NodeMap.initNodeMap(get, set)),
	} satisfies FilterEditorBase)

	function validate(state: FilterEditor) {
		const filter = F.treeToFilterNode(state.tree)
		const validatedFilter = F.isValidFilterNode(filter) ? filter : null
		const baseQueryInput = validatedFilter ? Obj.deepClone(LQY.getEditFilterPageBaseInput(validatedFilter)) : undefined
		const referenceCycle = validatedFilter && state.editedFilterId ? findCycle(state.editedFilterId, validatedFilter) : null
		set({
			validatedFilter: validatedFilter ?? null,
			referenceCycle,
			baseQueryInput,
			valid: validatedFilter !== null && !referenceCycle,
		})
	}
	void Prom.sleep(0).then(() => validate(get()))

	const validateSub = args.update$
		.pipe(Rx.throttleTime(150, Rx.asyncScheduler, { leading: true, trailing: true }), Rx.retry())
		.subscribe(([state, prev]) => {
			if (state.tree !== prev.tree) {
				validate(state)
			}
		})
	args.cleanup.push(validateSub)

	if (filterId) {
		args.cleanup.push(
			FilterEditClient.watchUpdates$(filterId).subscribe((update) => {
				const prev = get().session
				const next = ODSM.Client.applyUpdate(prev, update, FE.reducer, {
					onSideEffects: (ses) => {
						for (const se of ses) emitPresenceEvent(presenceEvent$, se)
					},
					onDiverged: (phase, error) =>
						console.error(`${phase === 'op' ? 'incoming' : 'acked'} filter ops diverged from the server:`, error.data),
					// a 'noop' rejection changed nothing on the local timeline and has nothing to report
					onRejected: (reason) => {
						if (reason !== 'noop') console.error('filter ops rejected by the server:', reason)
					},
					onUnknownAcks: (opIds) => console.warn('received ack for unknown filter ops', opIds),
				})
				if (next !== prev) commitSession(set, next)
			}),
		)
	}

	LayerTablePrt.initLayerTable(args)
}

// the draft and everything read straight off it, written together so no render sees a tree from one op and a
// modified flag from another
function commitSession(set: Zus.Setter<FilterEditor>, session: ODSM.Client.Session<FE.Op, FE.State>) {
	const state = session.localState
	set({
		session,
		tree: state.draft.tree,
		meta: state.draft.meta,
		modified: FE.isModified(state),
	})
}

function emitPresenceEvent(presenceEvent$: Rx.Subject<UP.PresenceEvent>, se: FE.SideEffect) {
	if (se.code !== 'op-outcome' || !se.success) return
	if (!('userId' in se.op)) return
	if (se.op.code === 'save') presenceEvent$.next({ userId: se.op.userId, action: 'saved-filter' })
	if (se.op.code === 'reset-to-saved') presenceEvent$.next({ userId: se.op.userId, action: 'discarded-filter-edits' })
}

export const frame = frameManager.createFrame<Types>({
	name: 'filterEditor',
	setup,
	createKey: (frameId, input) => ({ frameId, editedFilterId: input.editedFilterId, instanceId: input.instanceId }),
})

export namespace Sel {
	export const nodePath = (id: string | undefined) => (state: FilterEditor) => (id ? state.tree.paths.get(id) : undefined)

	export const immediateChildren = (id: string) => (state: FilterEditor) => F.resolveImmediateChildren(state.tree, id)

	export const node =
		(id: string) =>
		(state: FilterEditor): F.ShallowEditableFilterNode =>
			state.tree.nodes.get(id)!

	export const idByPath =
		(path: Sparse.NodePath) =>
		(state: FilterEditor): string | undefined =>
			MapUtils.revLookup(state.tree.paths, path, Sparse.serializeNodePath)

	export const createHint =
		(id: string) =>
		(state: FilterEditor): CreateHint | undefined =>
			state.createHints.get(id)

	export const comment =
		(id: string) =>
		(state: FilterEditor): string | undefined =>
			state.tree.nodes.get(id)?.comment

	export const commentEdited = (id: string) => (state: FilterEditor) => state.editedComments.has(id)
}

export type CommonNodeActions = {
	delete(): void
	setComment(comment: string | null): void
	setCommentEdited(edited: boolean): void
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
		return Zus.resolveStore<FilterEditor>(stores.filterEditor)
	}

	// authors ops on the local timeline and sends them on, exactly as the queue does. A batch the reducer
	// refuses against local state is dropped here rather than sent -- see ODSM.Client.processOutgoingOps.
	export function dispatch(stores: KeyProp, ...newOps: FE.NewClientOp[]) {
		const userId = UsersClient.loggedInUserId
		if (!userId) return
		const s = store(stores)
		const ops = newOps.map((op) => ({ ...op, opId: FE.createOpId(), userId }) as FE.Op)
		const prev = s.getState().session
		const res = ODSM.Client.processOutgoingOps(prev, ops, FE.reducer)
		if (res.rejected) return
		commitSession(s.setState, res.session)
		const state = s.getState()
		// a filter that has not been created yet has no session on the server to dispatch to
		if (!state.shared || !state.editedFilterId) return
		// an edit made without pressing anything still claims an editing session, which is what keeps the
		// shared draft alive. A save ends everyone's session, so it must not re-open one.
		if (!ops.some((op) => op.code === 'save')) UPClient.Actions.ensureEditingFilter(state.editedFilterId)
		void FilterEditClient.dispatchOps(state.editedFilterId, ops).then((res) => {
			if (res.code === 'ok') return
			// the server never applied these, and a pending op that is never acked doesn't just lose its own
			// edit: until pendingOps drains, no later server update reaches localState at all
			const dropped = ODSM.Client.dropPendingOps(
				s.getState().session,
				ops.map((op) => op.opId),
				FE.reducer,
			)
			commitSession(s.setState, dropped)
			if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
			else console.error('filter ops refused by the server:', res.code)
		})
	}

	export function moveNode(stores: KeyProp, sourcePath: Sparse.NodePath, targetPath: Sparse.NodePath) {
		const tree = store(stores).getState().tree
		// ops address nodes by id: a path resolved on one replica means something else on another once a
		// concurrent insert has shifted it
		const nodeId = MapUtils.revLookup(tree.paths, sourcePath, Sparse.serializeNodePath)
		const parentId = MapUtils.revLookup(tree.paths, targetPath.slice(0, -1), Sparse.serializeNodePath)
		if (!nodeId || !parentId) return
		dispatch(stores, { code: 'move-node', nodeId, parentId, index: targetPath[targetPath.length - 1] })
	}

	export function updateRoot(stores: KeyProp, filter: F.EditableFilterNode) {
		dispatch(stores, { code: 'replace-tree', tree: FE.toTree(filter) })
		store(stores).setState({ createHints: new Map(), editedComments: new Set() })
	}

	export function setNodeComment(stores: KeyProp, id: string, comment: string | null) {
		dispatch(stores, { code: 'set-comment', nodeId: id, comment: comment?.trim() || null })
	}

	export function setCommentEdited(stores: KeyProp, id: string, edited: boolean) {
		const s = store(stores)
		const editedComments = new Set(s.getState().editedComments)
		if (edited) editedComments.add(id)
		else editedComments.delete(id)
		s.setState({ editedComments })
	}

	export function updateNode(stores: KeyProp, id: string, cb: (draft: Im.Draft<F.ShallowEditableFilterNode>) => void) {
		const current = store(stores).getState().tree.nodes.get(id)
		if (!current) return
		dispatch(stores, { code: 'update-node', nodeId: id, node: Im.produce(current, cb) })
	}

	export function deleteNode(stores: KeyProp, id: string) {
		dispatch(stores, { code: 'delete-node', nodeId: id })
		const s = store(stores)
		const tree = s.getState().tree
		const editedComments = new Set([...s.getState().editedComments].filter((nodeId) => tree.nodes.has(nodeId)))
		s.setState({ editedComments })
	}

	export function addChild(stores: KeyProp, parentId: string, type: F.NodeType) {
		addSeededChild(stores, parentId, EFB.nodeOfType(type))
	}

	export function addSeededChild(stores: KeyProp, parentId: string, seed: F.EditableFilterNode, hint?: CreateHint) {
		const s = store(stores)
		const nodeId = FE.createNodeId()
		dispatch(stores, { code: 'add-node', parentId, nodeId, node: F.toShallowNode(seed) })
		// the hint is one-shot chrome for whoever added the node, so it stays on this client
		if (hint) s.setState({ createHints: new Map(s.getState().createHints).set(nodeId, hint) })
	}

	export function setMeta(stores: KeyProp, patch: Partial<FE.Meta>) {
		dispatch(stores, { code: 'set-meta', patch })
	}

	export function save(stores: KeyProp) {
		dispatch(stores, { code: 'save' })
	}

	export function reset(stores: KeyProp) {
		dispatch(stores, { code: 'reset-to-saved' })
	}
}

export function getNodeActions(stores: KeyProp, id: string): NodeActions {
	const updateNode: UpdateNodeFn = (cb) => Actions.updateNode(stores, id, (draft) => cb(draft))

	return {
		common: {
			delete: () => Actions.deleteNode(stores, id),
			setComment: (comment) => Actions.setNodeComment(stores, id, comment),
			setCommentEdited: (edited) => Actions.setCommentEdited(stores, id, edited),
		},
		block: {
			setBlockType(type) {
				updateNode((draft) => {
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
				updateNode((draft) => {
					if (!F.isCompNode(draft)) return
					const next = typeof update === 'function' ? update(draft as F.EditableCompNode) : update
					// replace whole node contents (args count varies by operator), keeping only the new keys.
					// the comment is node chrome rather than part of the comparison, so it outlives the swap
					for (const key of Object.keys(draft)) {
						if (key !== 'comment' && !(key in next)) delete (draft as any)[key]
					}
					Object.assign(draft, next)
				})
			},
		},
		applyFilter: {
			setType(type) {
				updateNode((draft) => {
					if (!F.isApplyFilterNode(draft)) return
					draft.type = type
				})
			},
			setFilterId(filterId) {
				updateNode((draft) => {
					if (!F.isApplyFilterNode(draft)) return
					draft.filterId = filterId
				})
			},
		},
		matchup: {
			setType(type) {
				updateNode((draft) => {
					if (!F.isMatchupNode(draft)) return
					draft.type = type
				})
			},
			setLocked(locked) {
				updateNode((draft) => {
					if (!F.isMatchupNode(draft)) return
					draft.locked = locked
				})
			},
			swapTeams() {
				updateNode((draft) => {
					if (!F.isMatchupNode(draft)) return
					draft.teams = [draft.teams[1], draft.teams[0]]
				})
			},
			setTeamValues(teamIndex, column, values) {
				updateNode((draft) => {
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
