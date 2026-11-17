import * as Im from 'immer'
import * as React from 'react'

import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as NodeMap from '@/lib/node-map'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import * as Prom from '@/lib/promise-utils'
import * as RSel from '@/lib/reselect'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
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
import * as RPC from '@/orpc.client'
import * as FilterEditClient from '@/systems/filter-edit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
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
// one-shot intent recorded when a node is added or converted from the node kind menu, keyed by the node's id, and
// kept only until the editor is next opened or closed by hand (see Actions.setNodeEditing). `group` is the section a
// blank comparison's subject picker opens on; `focus`/`autoOpenLayers` steer that first editor as it mounts.
export type CreateHint = {
	group?: F.SubjectColumnGroup
	focus?: 'operator' | 'values'
	autoOpenLayers?: boolean
}

type FilterEditorBase = {
	editedFilterId?: string
	// the ID a filter that has not been created yet will be created under
	createId: string
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

	// matches the `data-filter-tree` attribute on this editor's tree, so DOM lookups for a node stay inside it. A tree
	// built from a stored filter derives its node ids from paths, so two editors on one page can share them.
	scopeId: string
	view: View

	validatedFilter: F.FilterNode | null
	// the tree the fields below were derived from; it is `tree` once validation has caught up with the last edit
	validatedTree: F.FilterNodeTree | null
	// what `errors` were lowered from. Errors are resolved to nodes against this tree, never a newer one
	lowered: LoweringInput | null
	// the apply-filter loop this edit would create, if any. A loop has no fixed point once the referenced
	// filters are inlined, so the server refuses to store one and saving is blocked here first.
	referenceCycle: F.FilterEntityId[] | null
	modified: boolean
	valid: boolean
	// a save went through, and the problem count is reported once validation has caught up with the draft
	reportProblemsWhenValidated: boolean

	nodeMapStore: Zus.StoreApi<NodeMap.NodeMapStore>
} & F.NodeValidationErrorStore &
	LayerTablePrt.Predicates

export type View = 'builder' | 'text'

type LoweringInput = { tree: F.FilterNodeTree; missExemption: F.FilterNode | null }

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
		createId: '',
		session,
		shared: !!filterId,
		tree: session.localState.draft.tree,
		meta: session.localState.draft.meta,
		presenceEvent$,
		createHints: new Map(),
		editedComments: new Set(),
		undo: UNDO.empty(),
		editingNodeId: null,
		scopeId: args.input.instanceId,
		view: 'builder',

		validatedFilter: null,
		validatedTree: null,
		lowered: null,
		referenceCycle: null,
		modified: false,
		valid: false,
		reportProblemsWhenValidated: false,

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

	// lowering reads the layer data, so it runs in the layer queries worker once structural validation has settled.
	// The draft is lowered again whenever the worker's copy of the filters changes, since it may apply one of them.
	const lowerSub = Rx.combineLatest([
		args.update$.pipe(
			Rx.map(([state]) => state),
			Rx.filter((state) => state.validatedTree === state.tree),
			Rx.map((state) => ({ input: loweringInput(state), filter: state.validatedFilter })),
			Rx.distinctUntilChanged((a, b) => a.input.tree === b.input.tree && a.input.missExemption === b.input.missExemption),
		),
		Zus.toObservable(LayerQueriesClient.Store, true).pipe(
			Rx.map(([state]) => state.backgroundStateEpoch),
			Rx.distinctUntilChanged(),
		),
	])
		.pipe(Rx.switchMap(([{ input, filter }]) => lowerDraft(input, filter)))
		.subscribe(({ input, errors }) => set({ errors, lowered: input }))
	args.cleanup.push(lowerSub)

	const savedProblemsSub = args.update$
		.pipe(
			Rx.map(([state]) => state),
			Rx.filter((state) => state.reportProblemsWhenValidated && Sel.validationCurrent(state)),
		)
		.subscribe((state) => {
			set({ reportProblemsWhenValidated: false })
			const count = Sel.problemCount(state)
			if (count > 0) toast.warning(...tr.toast(F_Msgs.savedWithProblems(count)))
		})
	args.cleanup.push(savedProblemsSub)

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

// A stored filter's miss exemption is part of its meta. A filter that has not been created yet, and the miss
// exemption's own editor, hold theirs elsewhere.
function loweringInput(state: FilterEditor): LoweringInput {
	return { tree: state.tree, missExemption: state.shared ? state.meta.missExemption : null }
}

function lowerDraft(input: LoweringInput, filter: F.FilterNode | null) {
	if (!filter) return Rx.of({ input, errors: NO_ERRORS })
	return new Rx.Observable<{ input: LoweringInput; errors: F.NodeValidationError[] }>((subscriber) => {
		const controller = new AbortController()
		LayerQueriesClient.validateFilter({ node: filter, missExemption: input.missExemption }, controller.signal).then(
			(errors) => subscriber.next({ input, errors }),
			(error: unknown) => {
				if (controller.signal.aborted) return
				console.error('validating the filter draft failed:', error)
				subscriber.next({ input, errors: NO_ERRORS })
			},
		)
		return () => controller.abort()
	})
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
const NO_ERRORS: F.NodeValidationError[] = []
// well above the node count of any filter shown at once
const NODE_SELECTORS_MAX = 2000

// the parts of a node that its errors name, marked in both its compact and its expanded view
export type NodeMarks = {
	columns: ReadonlySet<string>
	// as String() renders them
	values: ReadonlySet<string>
	// the filter an apply-filter node references
	filter: boolean
}

const NO_MARKS: NodeMarks = { columns: new Set(), values: new Set(), filter: false }

// One line of the problem summary. The errors a referenced filter owns share one line per apply-filter node.
export type ProblemRow =
	| { type: 'node'; key: string; nodeId: string | null; error: F.NodeValidationError }
	| { type: 'referenced'; key: string; nodeId: string | null; ownerFilterId: F.FilterEntityId; errors: F.NodeValidationError[] }

export namespace Sel {
	export const rootId = (state: FilterEditor) => state.tree.rootId

	export const loweringCurrent = (state: FilterEditor) => {
		const input = loweringInput(state)
		return state.lowered?.tree === input.tree && state.lowered.missExemption === input.missExemption
	}

	export const validationCurrent = (state: FilterEditor) => state.validatedTree === state.tree && loweringCurrent(state)

	export const view = (state: FilterEditor) => state.view

	export const scopeId = (state: FilterEditor) => state.scopeId

	export const errors = (state: FilterEditor) => state.errors ?? NO_ERRORS

	export const problemCount = (state: FilterEditor) => state.errors?.length ?? 0

	// per error, the node it marks: null for one that is not in this tree, or whose path no longer resolves
	const errorNodes = RSel.createSelector([errors, (state: FilterEditor) => state.lowered?.tree], (errors, tree) =>
		errors.map((error) => (tree && error.part === 'filter' ? F.resolveErrorNode(tree, error.rootPath) : null)),
	)

	const errorsByNode = RSel.createSelector([errors, errorNodes], (errors, nodeIds) => {
		const byNode = new Map<string, F.NodeValidationError[]>()
		errors.forEach((error, i) => {
			const nodeId = nodeIds[i]
			if (nodeId === null) return
			const list = byNode.get(nodeId)
			if (list) list.push(error)
			else byNode.set(nodeId, [error])
		})
		return byNode
	})

	export const nodeErrors = RSel.memoizeFactoryLru(
		(id: string) => RSel.createSelector([errorsByNode], (byNode) => byNode.get(id) ?? NO_ERRORS),
		NODE_SELECTORS_MAX,
	)

	export const nodeMarks = RSel.memoizeFactoryLru(
		(id: string) =>
			RSel.createSelector([nodeErrors(id)], (errors): NodeMarks => {
				if (errors.length === 0) return NO_MARKS
				const columns = new Set<string>()
				const values = new Set<string>()
				let filter = false
				for (const error of errors) {
					if (error.via.length > 0) {
						filter = true
						continue
					}
					switch (error.type) {
						case 'unmapped-column':
							columns.add(error.column)
							break
						case 'unmapped-value':
							values.add(String(error.value))
							break
						case 'unknown-filter':
						case 'recursive-filter':
							filter = true
							break
						case 'invalid-node':
							break
						default:
							assertNever(error)
					}
				}
				return { columns, values, filter }
			}),
		NODE_SELECTORS_MAX,
	)

	export const problemRows = RSel.createSelector([errors, errorNodes], (errors, nodeIds) => {
		const rows: ProblemRow[] = []
		const referenced = new Map<string, Extract<ProblemRow, { type: 'referenced' }>>()
		errors.forEach((error, i) => {
			const nodeId = nodeIds[i]
			if (error.via.length === 0 || !error.ownerFilterId) {
				rows.push({ type: 'node', key: `${error.part}:${error.path.join('.')}:${i}`, nodeId, error })
				return
			}
			const key = `${error.part}:${error.rootPath.join('.')}:${error.ownerFilterId}`
			const row = referenced.get(key)
			if (row) {
				row.errors.push(error)
				return
			}
			const created = { type: 'referenced' as const, key, nodeId, ownerFilterId: error.ownerFilterId, errors: [error] }
			referenced.set(key, created)
			rows.push(created)
		})
		return rows
	})

	export const depth = (id: string | undefined) => (state: FilterEditor) => (id ? F.nodeDepth(state.tree, id) : undefined)

	export const children = (id: string) => (state: FilterEditor) => state.tree.children.get(id) ?? NO_CHILDREN

	// whether `id` is `ancestorId` or one of its descendants
	export const isWithin = (id: string | undefined, ancestorId: string | undefined) => (state: FilterEditor) =>
		!!id && !!ancestorId && state.tree.nodes.has(id) && F.isWithin(state.tree, id, ancestorId)

	export const node =
		(id: string) =>
		(state: FilterEditor): F.ShallowEditableFilterNode =>
			state.tree.nodes.get(id)!

	export const nodeIfPresent = RSel.memoizeFactoryLru(
		(id: string) =>
			(state: FilterEditor): F.ShallowEditableFilterNode | undefined =>
				state.tree.nodes.get(id),
		NODE_SELECTORS_MAX,
	)

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
	export function setCreateId(stores: KeyProp, createId: string) {
		store(stores).setState({ createId })
	}

	// whether a filter that has not been created yet has the details it needs to be created
	export function detailsComplete(state: FilterEditor) {
		return (
			F.NewFilterEntitySchema.shape.name.safeParse(state.meta.name).success &&
			F.NewFilterEntitySchema.shape.id.safeParse(state.createId).success
		)
	}

	// Creates a filter that has not been created yet from its draft, under its createId. Resolves to whether it was
	// created.
	export async function create(stores: KeyProp): Promise<boolean> {
		const state = store(stores).getState()
		if (!state.validatedFilter) {
			toast.warning(...tr.toast(F_Msgs.invalid()))
			return false
		}
		const res = await RPC.orpc.filters.createFilter.call({ id: state.createId, ...state.meta, filter: state.validatedFilter })
		switch (res.code) {
			case 'ok': {
				UsersClient.invalidateLoggedInUser()
				const problemCount = Sel.problemCount(store(stores).getState())
				if (problemCount > 0) toast.warning(...tr.toast(F_Msgs.savedWithProblems(problemCount)))
				else toast(...tr.toast(F_Msgs.created()))
				return true
			}
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				return false
			case 'err:cyclical-reference':
				toast.error(...tr.toast(F_Msgs.cyclicalReference(res.cycle)))
				return false
			case 'err:already-exists':
				toast.error(...tr.toast(F_Msgs.idTaken(state.createId)))
				return false
			default:
				assertNever(res)
		}
	}

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
			if (res.code === 'ok') {
				// a filter that cannot be applied still saves, and the problem count is reported
				if (ops.some((op) => op.code === 'save')) s.setState({ reportProblemsWhenValidated: true })
				return
			}
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

	export function setView(stores: KeyProp, view: View) {
		store(stores).setState({ view })
	}

	// Scrolls to a node, marks it with the exclusive anchor highlight (index.css) and focuses its compact row. The node
	// is found through the DOM because the tree is rendered through portals.
	export function revealNode(stores: KeyProp, nodeId: string) {
		const s = store(stores)
		s.setState({ view: 'builder' })
		requestAnimationFrame(() => {
			const el = nodeElement(s.getState().scopeId, nodeId)
			if (el) reveal(el)
		})
	}

	// Reveals the node at a lowering error path once the tree has rendered. Gives up once the tree is on the page and
	// the path does not resolve against it, which happens when the filter has changed since the link was made.
	export function revealPath(stores: KeyProp, path: string[], signal: AbortSignal) {
		const s = store(stores)
		const attempt = () => {
			const state = s.getState()
			if (!nodeElement(state.scopeId, state.tree.rootId)) return false
			const nodeId = F.resolveErrorNode(state.tree, path)
			if (nodeId === null) return true
			const el = nodeElement(state.scopeId, nodeId)
			if (!el) return false
			reveal(el)
			return true
		}
		if (attempt()) return
		const observer = new MutationObserver(() => {
			if (attempt()) observer.disconnect()
		})
		observer.observe(document.body, { childList: true, subtree: true })
		signal.addEventListener('abort', () => observer.disconnect(), { once: true })
	}

	function nodeElement(scopeId: string, nodeId: string) {
		return document.querySelector<HTMLElement>(
			`[data-filter-tree="${CSS.escape(scopeId)}"] [data-filter-node-id="${CSS.escape(nodeId)}"]`,
		)
	}

	function reveal(el: HTMLElement) {
		for (const other of document.querySelectorAll('[data-anchor-highlight]')) {
			if (other !== el) other.removeAttribute('data-anchor-highlight')
		}
		el.setAttribute('data-anchor-highlight', 'true')
		el.scrollIntoView({ block: 'center', behavior: 'smooth' })
		el.querySelector<HTMLElement>('[data-node-summary]')?.focus({ preventScroll: true })
	}

	// a hint only steers the editor that opens as its node is added or converted, so opening any editor by hand,
	// or closing one, drops them all
	export function setNodeEditing(stores: KeyProp, id: string | null) {
		store(stores).setState({ editingNodeId: id, createHints: new Map() })
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
		// a new node has nothing to read yet, so it opens as its editor rather than as a compact row. The hint is
		// one-shot chrome for whoever added the node, so it stays on this client.
		s.setState({ editingNodeId: nodeId, createHints: hintsFor(nodeId, hint) })
	}

	// Turns a node into another kind of node where it stands, carrying over what still means something to the new
	// kind: a block keeps its children when it changes block type, an apply-filter node keeps its filter, a
	// matchup node keeps its teams, a matchup and a team comparison trade values (EFB.carryOver), and a leaf that becomes a block is kept as the block's first child. Anything else starts from `seed`, keeping
	// only the comment. The root stays a block, since the editor adds nodes through it.
	export function convertNode(stores: KeyProp, id: string, seed: F.EditableFilterNode, hint?: CreateHint) {
		const s = store(stores)
		const tree = s.getState().tree
		const current = tree.nodes.get(id)
		if (!current) return
		const parentId = tree.parents.get(id)
		const currentIsBlock = F.isEditableBlockNode(current)
		const seedIsBlock = F.isBlockType(seed.type)
		const withComment = (node: F.ShallowEditableFilterNode) =>
			current.comment ? ({ ...node, comment: current.comment } as F.ShallowEditableFilterNode) : node

		if (currentIsBlock && seedIsBlock) {
			updateNode(stores, id, (draft) => {
				draft.type = seed.type
			})
			return
		}
		if (!currentIsBlock && !seedIsBlock) {
			const sameFamily =
				(F.isApplyFilterNode(current) && F.isApplyFilterNode(seed)) || (F.isMatchupNode(current) && F.isMatchupNode(seed))
			const node = sameFamily
				? { ...current, type: seed.type }
				: withComment(F.toShallowNode(EFB.carryOver(current as F.EditableFilterNode, seed)))
			dispatch(stores, { code: 'update-node', nodeId: id, node: node as F.ShallowEditableFilterNode })
			s.setState({ editingNodeId: id, createHints: hintsFor(id, hint) })
			return
		}
		if (parentId === undefined) return
		const index = tree.children.get(parentId)!.indexOf(id)
		const nodeId = FE.createNodeId()
		if (seedIsBlock) {
			dispatch(
				stores,
				{ code: 'add-node', parentId, nodeId, node: F.toShallowNode(seed), index },
				{ code: 'move-node', nodeId: id, parentId: nodeId, index: 0 },
			)
		} else {
			dispatch(
				stores,
				{ code: 'add-node', parentId, nodeId, node: withComment(F.toShallowNode(seed)), index },
				{ code: 'delete-node', nodeId: id },
			)
		}
		if (!s.getState().tree.nodes.has(nodeId)) return
		s.setState({ editingNodeId: nodeId, createHints: hintsFor(nodeId, hint) })
		pruneNodeChrome(s)
	}

	// the hints once `nodeId`'s editor opens: only the node being edited has an editor for a hint to steer
	function hintsFor(nodeId: string, hint: CreateHint | undefined): Map<string, CreateHint> {
		return hint ? new Map([[nodeId, hint]]) : new Map()
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
