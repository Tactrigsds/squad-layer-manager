import * as Im from 'immer'
import * as React from 'react'

import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as NodeMap from '@/lib/node-map'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import * as UNDO from '@/lib/undo-stack'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as EFB from '@/models/editable-filter-builders.models'
import * as FE from '@/models/filter-edit.models'
import * as FR from '@/models/filter-references.models'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import type * as UP from '@/models/user-presence.models'
import * as FilterEditClient from '@/systems/filter-edit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
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
	// this client's own edits. An entry holds the ops that reverse it, recomputed each time it is undone or redone
	undo: UNDO.Stack<UndoData>
	// the one node showing its editor instead of its compact form. A node has to be asked for by name, so
	// opening one closes whichever was open, and a node that goes away takes its editor with it.
	editingNodeId: string | null

	validatedFilter: F.FilterNode | null
	// the tree the fields below were derived from; it is `tree` once validation has caught up with the last edit
	validatedTree: F.FilterNodeTree | null
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

export type UndoData = { ops: FE.NewClientOp[] }

// the newer entry's inverse runs first, since its edit happened last
const mergeUndo = (older: UndoData, newer: UndoData): UndoData => ({ ops: [...newer.ops, ...older.ops] })

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
		undo: UNDO.empty(),
		editingNodeId: null,

		validatedFilter: null,
		validatedTree: null,
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
			validatedTree: state.tree,
			referenceCycle,
			baseQueryInput,
			valid: validatedFilter !== null && !referenceCycle,
		})
	}
	void Prom.sleep(0).then(() => validate(get()))

	// the tree filter comes before the throttle, not inside the subscriber. Throttling first drops emissions,
	// so the survivor's `prev` is not the state the tree changed from: any unrelated `set` landing in the same
	// 150ms window makes the change look like a no-op and the edit is never validated again
	const validateSub = args.update$
		.pipe(
			Rx.map(([state]) => state),
			Rx.distinctUntilKeyChanged('tree'),
			Rx.throttleTime(150, Rx.asyncScheduler, { leading: true, trailing: true }),
			Rx.retry(),
		)
		.subscribe(validate)
	args.cleanup.push(validateSub)

	if (filterId) {
		args.cleanup.push(
			FilterEditClient.watchUpdates$(filterId, (update) => {
				const prev = get().session
				const next = ODSM.Client.applyUpdate(prev, update, FE.reducer, {
					onSideEffects: (ses) => {
						for (const se of ses) {
							emitPresenceEvent(presenceEvent$, se)
							if (discardsOthersEdits(se)) set({ undo: UNDO.empty() })
						}
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
			}).subscribe(),
		)
	}

	LayerTablePrt.initLayerTable(args)
}

// the draft and everything read straight off it, written together so no render sees a tree from one op and a
// modified flag from another
function commitSession(set: Zus.Setter<FilterEditor>, session: ODSM.Client.Session<FE.Op, FE.State>) {
	const state = session.localState
	// no reconciling here: the reducer is copy-on-write, so an op that left the tree or the meta alone hands
	// back the same objects and the selectors reading them never fire
	set({
		session,
		tree: state.draft.tree,
		meta: state.draft.meta,
		modified: FE.isModified(state),
	})
}

// the edits this client could undo were discarded with the draft
function discardsOthersEdits(se: FE.SideEffect) {
	if (se.code !== 'op-outcome' || !se.success) return false
	if (se.op.code === 'discard-abandoned-edits') return true
	return se.op.code === 'reset-to-saved' && se.op.userId !== UsersClient.loggedInUserId
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

const NO_CHILDREN: readonly string[] = []

export namespace Sel {
	export const rootId = (state: FilterEditor) => state.tree.rootId

	export const validationCurrent = (state: FilterEditor) => state.validatedTree === state.tree

	export const depth = (id: string | undefined) => (state: FilterEditor) => (id ? F.nodeDepth(state.tree, id) : undefined)

	export const children = (id: string) => (state: FilterEditor) => state.tree.children.get(id) ?? NO_CHILDREN

	// whether `id` is `ancestorId` or one of its descendants
	export const isWithin = (id: string | undefined, ancestorId: string | undefined) => (state: FilterEditor) =>
		!!id && !!ancestorId && state.tree.nodes.has(id) && F.isWithin(state.tree, id, ancestorId)

	export const node =
		(id: string) =>
		(state: FilterEditor): F.ShallowEditableFilterNode =>
			state.tree.nodes.get(id)!

	export const createHint =
		(id: string) =>
		(state: FilterEditor): CreateHint | undefined =>
			state.createHints.get(id)

	export const comment =
		(id: string) =>
		(state: FilterEditor): string | undefined =>
			state.tree.nodes.get(id)?.comment

	export const commentEdited = (id: string) => (state: FilterEditor) => state.editedComments.has(id)

	export const nodeEditing = (id: string) => (state: FilterEditor) => state.editingNodeId === id

	export const undoEntry = (state: FilterEditor) => UNDO.peekUndo(state.undo)

	export const redoEntry = (state: FilterEditor) => UNDO.peekRedo(state.undo)
}

export type CommonNodeActions = {
	delete(): void
	duplicate(): void
	setComment(comment: string | null): void
	setCommentEdited(edited: boolean): void
	setEditing(editing: boolean): void
}

// an omitted index appends, which is what the block header's own add button does
export type BlockNodeActions = {
	setBlockType: (type: F.BlockType) => void
	addChild: (type: F.NodeType, index?: number) => void
	addSeeded: (seed: F.EditableFilterNode, hint?: CreateHint, index?: number) => void
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

	export function dispatch(stores: KeyProp, ...newOps: FE.NewClientOp[]) {
		send(stores, newOps, { record: true })
	}

	// consecutive edits with the same key, close together, undo as one
	export function dispatchKeyed(stores: KeyProp, undoKey: string, ...newOps: FE.NewClientOp[]) {
		send(stores, newOps, { record: true, undoKey })
	}

	// Authors ops on the local timeline and sends them on, exactly as the queue does. A batch the reducer refuses
	// against local state is dropped here rather than sent -- see ODSM.Client.processOutgoingOps. Returns the ops that
	// reverse the batch, or null when it was refused or cannot be reversed.
	function send(
		stores: KeyProp,
		newOps: FE.NewClientOp[],
		opts: { record: boolean; undoKey?: string },
	): { opIds: string[]; inverse: FE.NewClientOp[] | null } | null {
		const userId = UsersClient.loggedInUserId
		if (!userId) return null
		const s = store(stores)
		const ops = newOps.map((op) => ({ ...op, opId: FE.createOpId(), userId }) as FE.Op)
		const prev = s.getState().session
		const res = ODSM.Client.processOutgoingOps(prev, ops, FE.reducer)
		if (res.rejected) return null
		const inverse = FE.invertOps(prev.localState, newOps)
		const opIds = ops.map((op) => op.opId)
		commitSession(s.setState, res.session)
		if (opts.record && inverse) {
			const entry: UNDO.Entry<UndoData> = {
				id: opIds[0],
				kind: newOps.at(-1)!.code,
				opIds,
				at: Date.now(),
				key: opts.undoKey,
				data: { ops: inverse },
			}
			s.setState({ undo: UNDO.push(s.getState().undo, entry, mergeUndo) })
		}
		const state = s.getState()
		// a filter that has not been created yet has no session on the server to dispatch to
		if (!state.shared || !state.editedFilterId) return { opIds, inverse }
		// an edit made without pressing anything still claims an editing session, which is what keeps the
		// shared draft alive. A save ends everyone's session, so it must not re-open one.
		if (!ops.some((op) => op.code === 'save')) UPClient.Actions.ensureEditingFilter(state.editedFilterId)
		const sent = FilterEditClient.dispatchOps(state.editedFilterId, ops).catch((error: unknown) => {
			console.error('filter ops dispatch failed:', error)
			return { code: 'err:dispatch-failed' as const }
		})
		void sent.then((res) => {
			if (res.code === 'ok') return
			// the server never applied these, and a pending op that is never acked doesn't just lose its own
			// edit: until pendingOps drains, no later server update reaches localState at all
			const dropped = ODSM.Client.dropPendingOps(s.getState().session, opIds, FE.reducer)
			commitSession(s.setState, dropped)
			let undo = s.getState().undo
			for (const opId of opIds) undo = UNDO.removeByOpId(undo, opId)
			s.setState({ undo })
			if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
			else console.error('filter ops refused by the server:', res.code)
		})
		return { opIds, inverse }
	}

	export function undo(stores: KeyProp) {
		const entry = UNDO.peekUndo(store(stores).getState().undo)
		if (entry) step(stores, entry, 'undo')
	}

	export function redo(stores: KeyProp) {
		const entry = UNDO.peekRedo(store(stores).getState().undo)
		if (entry) step(stores, entry, 'redo')
	}

	// Sends an entry's reversing ops, and keeps what reverses them in turn for the other direction. Ops another user's
	// edit has made impossible, such as an update to a node they deleted, are refused here and the entry is dropped.
	function step(stores: KeyProp, entry: UNDO.Entry<UndoData>, direction: 'undo' | 'redo') {
		const s = store(stores)
		const sent = send(stores, entry.data.ops, { record: false })
		if (!sent || !sent.inverse) {
			s.setState({ undo: UNDO.removeEntry(s.getState().undo, entry.id) })
			toast.error(...tr.toast(UI_Msgs.cannotUndo()))
			return
		}
		const moved: UNDO.Entry<UndoData> = { ...entry, opIds: sent.opIds, data: { ops: sent.inverse } }
		const stack = s.getState().undo
		s.setState({ undo: direction === 'undo' ? UNDO.undone(stack, moved) : UNDO.redone(stack, moved) })
		pruneNodeChrome(s)
	}

	// an undo can take away the node whose editor or comment is open
	function pruneNodeChrome(s: Zus.StoreApi<FilterEditor>) {
		const state = s.getState()
		const tree = state.tree
		const editedComments = new Set([...state.editedComments].filter((nodeId) => tree.nodes.has(nodeId)))
		const editingNodeId = state.editingNodeId && tree.nodes.has(state.editingNodeId) ? state.editingNodeId : null
		s.setState({ editedComments, editingNodeId })
	}

	export function moveNode(stores: KeyProp, nodeId: string, parentId: string, index: number) {
		dispatch(stores, { code: 'move-node', nodeId, parentId, index })
	}

	export function updateRoot(stores: KeyProp, filter: F.EditableFilterNode) {
		dispatchKeyed(stores, 'replace-tree', { code: 'replace-tree', tree: FE.toTree(filter) })
		store(stores).setState({ createHints: new Map(), editedComments: new Set(), editingNodeId: null })
	}

	export function setNodeEditing(stores: KeyProp, id: string | null) {
		store(stores).setState({ editingNodeId: id })
	}

	export function setNodeComment(stores: KeyProp, id: string, comment: string | null) {
		dispatchKeyed(stores, `set-comment:${id}`, { code: 'set-comment', nodeId: id, comment: comment?.trim() || null })
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
		dispatchKeyed(stores, `update-node:${id}`, { code: 'update-node', nodeId: id, node: Im.produce(current, cb) })
	}

	export function deleteNode(stores: KeyProp, id: string) {
		dispatch(stores, { code: 'delete-node', nodeId: id })
		pruneNodeChrome(store(stores))
	}

	export function addChild(stores: KeyProp, parentId: string, type: F.NodeType, index?: number) {
		addSeededChild(stores, parentId, EFB.nodeOfType(type), undefined, index)
	}

	export function addSeededChild(stores: KeyProp, parentId: string, seed: F.EditableFilterNode, hint?: CreateHint, index?: number) {
		const s = store(stores)
		const nodeId = FE.createNodeId()
		dispatch(stores, { code: 'add-node', parentId, nodeId, node: F.toShallowNode(seed), index })
		if (!s.getState().tree.nodes.has(nodeId)) return
		// a new node has nothing to read yet, so it opens as its editor rather than as a compact row
		s.setState({ editingNodeId: nodeId })
		// the hint is one-shot chrome for whoever added the node, so it stays on this client
		if (hint) s.setState({ createHints: new Map(s.getState().createHints).set(nodeId, hint) })
	}

	export function duplicateNode(stores: KeyProp, id: string) {
		const subtree = F.copySubtree(store(stores).getState().tree, id)
		if (!subtree) return
		dispatch(stores, { code: 'clone-node', nodeId: id, subtree })
	}

	export function setMeta(stores: KeyProp, patch: Partial<FE.Meta>) {
		dispatchKeyed(stores, `set-meta:${Object.keys(patch).sort().join(',')}`, { code: 'set-meta', patch })
	}

	export function save(stores: KeyProp) {
		dispatch(stores, { code: 'save' })
	}

	// a discard is the one edit that throws away work, so it offers its undo where the user is looking
	export function reset(stores: KeyProp) {
		const before = store(stores).getState().undo
		dispatch(stores, { code: 'reset-to-saved' })
		const entry = UNDO.peekUndo(store(stores).getState().undo)
		if (!entry || entry === UNDO.peekUndo(before) || entry.kind !== 'reset-to-saved') return
		const [message, toastOpts] = tr.toast(F_Msgs.editsDiscarded())
		toast.info(message, {
			...toastOpts,
			action: {
				label: tr.text(UI_Msgs.undo()),
				onClick: () => {
					if (UNDO.peekUndo(store(stores).getState().undo)?.id === entry.id) undo(stores)
				},
			},
		})
	}
}

export function getNodeActions(stores: KeyProp, id: string): NodeActions {
	const updateNode: UpdateNodeFn = (cb) => Actions.updateNode(stores, id, (draft) => cb(draft))

	return {
		common: {
			delete: () => Actions.deleteNode(stores, id),
			duplicate: () => Actions.duplicateNode(stores, id),
			setComment: (comment) => Actions.setNodeComment(stores, id, comment),
			setCommentEdited: (edited) => Actions.setCommentEdited(stores, id, edited),
			setEditing: (editing) => Actions.setNodeEditing(stores, editing ? id : null),
		},
		block: {
			setBlockType(type) {
				updateNode((draft) => {
					draft.type = type
				})
			},
			addChild: (type: F.NodeType, index?: number) => {
				Actions.addChild(stores, id, type, index)
			},
			addSeeded: (seed, hint, index) => {
				Actions.addSeededChild(stores, id, seed, hint, index)
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
