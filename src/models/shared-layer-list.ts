import * as Arr from '@/lib/array-utils'
import { createId } from '@/lib/id'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as BB from '@/models/backburner.models'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import * as LTag from '@/models/layer-tags.models'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'

import * as L from './layer'

const opPropsBase = { opId: z.string() }
// `userId` is the person operating the editor: it drives presence and who a save overrode. Absent when
// nothing human issued the op, which is a plugin editing the queue; everything reading it already guards for
// that. `source` is what the op is attributed to, and what new items record. They agree for a person, and
// only `source` can name a plugin, so it is what the audit log reads.
const opPropsClient = { userId: USR.UserIdSchema.optional(), source: LL.SourceSchema.optional() }
const opPropsEditWindow = { editWindowSeqId: z.number() }

// when present ensures that this op is only applied during the edit window it was intended for
function getItemOpEntries<Props extends { [key: string]: z.ZodType }>(props: Props) {
	return [
		z.object({
			...props,
			op: z.literal('move'),
			cursor: LL.CursorSchema,
			newFirstItemId: LL.ItemIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('swap-factions'),
		}),
		z.object({
			...props,
			op: z.literal('edit-layer'),
			newLayerId: L.LayerIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('add-tag'),
			tagId: LTag.TagIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('remove-tag'),
			tagId: LTag.TagIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('add-note'),
			noteId: LNote.NoteIdSchema,
			text: LNote.TextSchema,
		}),
		z.object({
			...props,
			op: z.literal('edit-note'),
			noteId: LNote.NoteIdSchema,
			text: LNote.TextSchema,
		}),
		z.object({
			...props,
			op: z.literal('delete-note'),
			noteId: LNote.NoteIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('clone'),
			itemId: LL.ItemIdSchema,
		}),
		z.object({
			...props,
			op: z.literal('configure-vote'),

			// null means use defaults(remove), undefined means don't modify
			config: V.AdvancedVoteConfigSchema.nullable(),
		}),
		z.object({
			...props,
			op: z.literal('delete'),
		}),
	] as const
}

const ItemOperationSchema = z.discriminatedUnion(
	'op',
	getItemOpEntries({ ...opPropsBase, ...opPropsClient, ...opPropsEditWindow, itemId: LL.ItemIdSchema }),
)
export type ItemOperation = z.infer<typeof ItemOperationSchema>

export const NewContextItemOperationSchema = z.discriminatedUnion('op', getItemOpEntries({}))
export type NewContextItemOperation = z.infer<typeof NewContextItemOperationSchema>

function buildOperationSchema<
	Item extends z.ZodType,
	BaseProps extends { [key: string]: z.ZodType },
	ClientProps extends { [key: string]: z.ZodType },
	EditWindowProps extends { [key: string]: z.ZodType },
>(itemSchema: Item, baseProps: BaseProps, clientProps: ClientProps, editWindowProps: EditWindowProps) {
	return z.discriminatedUnion('op', [
		z.object({
			...baseProps,
			op: z.literal('init'),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('add'),
			items: z.array(itemSchema),
			index: LL.ItemIndexSchema,
		}),
		z.object({
			...opPropsBase,
			op: z.literal('shift-first-saved-layer'),
		}),
		z.object({
			...baseProps,
			// server-only op, used to insert first layer into the savedItems if it's changed on the server
			op: z.literal('unshift-first-saved-layer'),
			layerId: L.LayerIdSchema,
			itemSource: LL.SourceSchema,
			itemId: LL.ItemIdSchema,
			// the external actor whose layer change triggered this reconciliation (used to attribute the QUEUE_UPDATED);
			// 'unknown' is a change SLM found rather than watched happen, absent for internal sources
			externalSource: z
				.discriminatedUnion('type', [
					z.object({ type: z.literal('player'), playerId: z.string() }),
					z.object({ type: z.literal('rcon') }),
					z.object({ type: z.literal('unknown') }),
				])
				.optional(),
		}),
		z.object({
			...baseProps,
			op: z.literal('set-vote-result'),
			voteItemId: LL.ItemIdSchema,
			result: V.EndingVoteStateSchema.nullable(),
		}),
		z.object({
			...baseProps,
			op: z.literal('queue-item-generated'),
			item: itemSchema,
			// backburner templates the generated layer satisfies; removed from the backburner in the same op so the
			// generated item and its consumption converge atomically on every replica
			consumedBackburnerItemIds: z.array(BB.ItemIdSchema).optional(),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('backburner-add'),
			item: BB.BackburnerItemSchema,
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('backburner-update'),
			itemId: BB.ItemIdSchema,
			filter: BB.BackburnerItemSchema.shape.filter,
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('backburner-remove'),
			itemIds: z.array(BB.ItemIdSchema).min(1),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('backburner-reorder'),
			itemId: BB.ItemIdSchema,
			newIndex: z.number().int().min(0),
		}),
		// merges source's constraints into target (target keeps its identity and position) and drops source.
		// combinability (the merged template still having solutions) is validated by the dispatcher, not here.
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('backburner-combine'),
			targetItemId: BB.ItemIdSchema,
			sourceItemId: BB.ItemIdSchema,
		}),
		// server-only: a write straight to the saved backburner (chat commands, evictions). Applied to both the
		// saved and draft lists so in-flight GUI edits survive, and exempt from edit windows and the generation gate.
		z.object({
			...baseProps,
			op: z.literal('backburner-write-saved'),
			write: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('add'), item: BB.BackburnerItemSchema, evictItemIds: z.array(BB.ItemIdSchema) }),
				z.object({ kind: z.literal('remove'), itemIds: z.array(BB.ItemIdSchema).min(1) }),
			]),
			source: USR.GuiOrChatUserIdSchema.optional(),
		}),
		// the backburner's own save/reset: its editing session is fully separate from the queue's
		z.object({
			...baseProps,
			...clientProps,
			op: z.literal('backburner-save'),
			// saved while others were still editing (the presence-level "force save" workaround)
			force: z.boolean().optional(),
		}),
		z.object({
			...baseProps,
			...clientProps,
			op: z.literal('backburner-reset'),
		}),
		// server-only: the last client editing the backburner went away without finishing (navigated off,
		// disconnected, timed out), so nobody is left to commit the draft and it is dropped
		z.object({
			...baseProps,
			op: z.literal('discard-abandoned-request-edits'),
		}),
		...getItemOpEntries({ ...baseProps, ...clientProps, ...editWindowProps, itemId: LL.ItemIdSchema }),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('clear'),
			itemIds: z.array(LL.ItemIdSchema),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			// uses "source" to determine what user finished editing
			op: z.literal('save'),
			// the user saved while others were still editing, bypassing the usual "last editor out saves" rule.
			// carried so the QUEUE_UPDATED app event can record who was overridden.
			force: z.boolean().optional(),
		}),
		z.object({
			...baseProps,
			op: z.literal('save-completed'),
		}),
		z.object({
			...baseProps,
			...clientProps,
			...editWindowProps,
			op: z.literal('reset-to-saved'),
		}),
		// the queue-side counterpart of discard-abandoned-request-edits
		z.object({
			...baseProps,
			op: z.literal('discard-abandoned-queue-edits'),
		}),
	])
}

const CLIENT_OPCODE = z.enum([
	'add',
	'move',
	'swap-factions',
	'edit-layer',
	'add-tag',
	'remove-tag',
	'add-note',
	'edit-note',
	'delete-note',
	'clone',
	'configure-vote',
	'delete',
	'clear',
	'save',
	'reset-to-saved',
	'backburner-add',
	'backburner-update',
	'backburner-remove',
	'backburner-reorder',
	'backburner-combine',
	'backburner-save',
	'backburner-reset',
])
type ClientOpcode = z.infer<typeof CLIENT_OPCODE>

export const OperationSchema = buildOperationSchema(LL.ItemSchema, opPropsBase, opPropsClient, opPropsEditWindow)
export type Operation = z.infer<typeof OperationSchema>
export type OpCode = Operation['op']

export const NewOperationSchema = buildOperationSchema(LL.NewItemSchema, {}, {}, {})
export type NewOperation = z.infer<typeof NewOperationSchema>
export type NewClientOperation = Extract<NewOperation, { op: ClientOpcode }>

export function isOpForItem(op: Operation): op is ItemOperation {
	return ItemOperationSchema.options.map((op) => op.shape.op.value as string).includes(op.op)
}

export type State = {
	list: LL.List
	// incremented whenever we save or reset the list. used to throw away latent operations that were intended for a previous edit window
	editWindowSeqId: number
	savedList: LL.List
	saving: boolean
	mutations: ItemMut.Mutations
	requestingGeneratedQueueItem: boolean
	lastSaveOpId: null | string
	// the layer backburner (in-game "layer requests"), sharing this session so ops can atomically span both
	// collections. draft vs saved works like the queue's list/savedList. Its editing session is separate from
	// the queue's, so it gates its draft ops with its own window counter
	backburner: BB.BackburnerItem[]
	savedBackburner: BB.BackburnerItem[]
	backburnerEditWindowSeqId: number
}

// the typed payload carried by a RejectedError thrown from the reducer, for the dispatcher to surface
// or log. an op is skipped when it is stale (edit window changed, pending generation); the schema
// variants indicate the op would have produced structurally invalid state
export type Rejection =
	| { code: 'op-skipped'; op: Operation }
	| { code: 'invalid-list'; error: z.ZodError }
	| { code: 'invalid-saved-list'; error: z.ZodError }

export type SideEffect =
	| {
			// saved list has changed, and needs to be written to the database and/or published to the squad server
			code: 'request-list-save'
			list: LL.List
			// the saved list before this save -- diffed against `list` for the QUEUE_UPDATED app event
			prevList: LL.List
			opId: string
			lastSaveOpId: null | string
	  }
	| {
			// requests that a queue item be generated before the list is saved. happens when the saved list would be empty
			code: 'request-queue-item-generation'
	  }
	| {
			// the saved backburner changed and needs to be written to the database (and app events emitted)
			code: 'request-backburner-save'
			items: BB.BackburnerItem[]
			prevItems: BB.BackburnerItem[]
			opId: string
			trigger: 'user-save' | 'chat-write' | 'consumed'
			source?: USR.GuiOrChatUserId
			// for 'consumed': the generated layer that satisfied the consumed templates
			layerId?: string | null
	  }
	| {
			// the save had nothing to write, but the edit window still closed -- editors are done and the draft
			// state was reset, so this is the no-write counterpart of 'request-list-save'
			code: 'edit-window-closed'
	  }
	| {
			// success is false when the op was skipped (stale edit window, pending generation)
			code: 'op-outcome'
			op: Operation
			success: boolean
	  }
	| {
			// no more sideEffects for this reducer call
			code: 'complete'
			opId: string
	  }

export type Update = ODSM.ClientUpdate<State, Operation, Rejection['code']>

// the sequence id of the base queue the session
const QueueSequenceId = z.number()
export type SessionSequenceId = z.infer<typeof QueueSequenceId>

export function createOpId(): string {
	return createId(16)
}

export const reducer: ODSM.Reducer<Operation, State, SideEffect> = (oldState, ops, _prevOps) => {
	// Copy-on-write. The four collections are forked so ops can splice them, but nothing inside them is ever
	// mutated: ODSM replays this reducer against the optimistic, synced and authoritative base states, which
	// share their items with each other, so one missed copy corrupts all of them at once.
	const state: State = {
		...oldState,
		list: [...oldState.list],
		savedList: [...oldState.savedList],
		mutations: ItemMut.cloneMutations(oldState.mutations),
	}
	const sideEffects: SideEffect[] = []
	const emit = (se: SideEffect) => sideEffects.push(se)
	// ops in a batch are dependent, so a single skipped op rejects the whole batch (RejectedError)
	// rather than applying a partial result
	for (const op of ops) {
		const success = applyOperation(state, op, emit)
		emit({ code: 'op-outcome', op, success })
		if (!success) throw new ODSM.RejectedError<Rejection>({ code: 'op-skipped', op }, { message: `operation ${op.op} skipped` })
	}
	reshare(oldState, state)
	validateList(state.list, oldState.list, 'invalid-list', 'list')
	validateList(state.savedList, oldState.savedList, 'invalid-saved-list', 'savedList')
	emit({ code: 'complete', opId: ops.at(-1)?.opId ?? '' })
	return [state, sideEffects]
}

// ListSchema is a plain array of ItemSchema, and no item is ever mutated, so an item still shared with the base
// list was parsed by whichever batch produced it -- or, for the first batch, by the ServerStateSchema.parse that
// read it out of the db. Only the items whose reference moved need re-parsing, which at 20 queue items is the
// difference between 300us per op and 15us.
function validateList(next: LL.List, base: LL.List, code: 'invalid-list' | 'invalid-saved-list', label: string) {
	if (next === base) return
	const alreadyValid = new Set<LL.Item>(base)
	for (const item of next) {
		if (alreadyValid.has(item)) continue
		const result = LL.ItemSchema.safeParse(item)
		if (!result.success) {
			throw new ODSM.RejectedError<Rejection>(
				{ code, error: result.error },
				{ message: `${label} failed schema validation`, cause: result.error },
			)
		}
	}
}

// the reducer forks all four collections up front, so an op that left one alone still produced a different
// array. Handing back the base's own reference is what lets a selector reading `list` skip the render.
function reshare(base: State, next: State) {
	if (Arr.shallowEquals(next.list, base.list)) next.list = base.list
	if (Arr.shallowEquals(next.savedList, base.savedList)) next.savedList = base.savedList
	if (Arr.shallowEquals(next.backburner, base.backburner)) next.backburner = base.backburner
	if (Arr.shallowEquals(next.savedBackburner, base.savedBackburner)) next.savedBackburner = base.savedBackburner
	if (ItemMut.mutationsEqual(next.mutations, base.mutations)) next.mutations = base.mutations
}

// a draft and its saved baseline share every item they have in common, so the answer is normally settled by
// pointer compares. The deep walk is the fallback for edits that cancelled each other out.
function contentEqual<T>(a: T[], b: T[]): boolean {
	return Arr.shallowEquals(a, b) || Obj.deepEqual(a, b)
}

// Splices and reassigns `session`'s collections, so it needs a session the caller owns -- the reducer's fork.
// What is inside them stays untouched. Returns whether the op was applied (as opposed to skipped).
export function applyOperation(session: State, newOp: Operation, onSideEffect?: ODSM.OnSideEffect<SideEffect>): boolean {
	const opWindowSeqId = (newOp as { editWindowSeqId?: number })?.editWindowSeqId
	const currentWindowSeqId = isBackburnerOp(newOp) ? session.backburnerEditWindowSeqId : session.editWindowSeqId
	if (opWindowSeqId !== undefined && opWindowSeqId !== currentWindowSeqId) {
		return false
	}
	if (newOp.op === 'queue-item-generated') {
		if (newOp.consumedBackburnerItemIds?.length) consumeBackburnerItems(session, newOp, onSideEffect)
		saveList(session, newOp, [newOp.item], onSideEffect)
		session.requestingGeneratedQueueItem = false
		return true
	}
	// backburner ops never touch the queue list, so they are exempt from the generation gate; the shared
	// editWindowSeqId gate above still applies to the draft ops (which carry a window id)
	if (isBackburnerOp(newOp)) return applyBackburnerOperation(session, newOp, onSideEffect)
	if (session.requestingGeneratedQueueItem) {
		return false
	}
	let source: LL.Source
	{
		const declared = (newOp as { source?: LL.Source })?.source
		const userId = (newOp as { userId?: USR.UserId })?.userId
		source = declared ?? (userId ? { type: 'manual', userId } : { type: 'unknown' })
	}
	// don't write to mutations if we're applying changes to the saved list, just throw them away instead
	const mutations = session.mutations
	const list = session.list

	switch (newOp.op) {
		case 'init': {
			if (session.savedList.length === 0) {
				session.requestingGeneratedQueueItem = true
				onSideEffect?.({ code: 'request-queue-item-generation' })
				return true
			}
			break
		}

		case 'shift-first-saved-layer': {
			const prevList = [...session.savedList]
			LL.splice(session.savedList, { outerIndex: 0, innerIndex: null }, 1)
			saveList(session, newOp, session.savedList, onSideEffect, prevList)
			break
		}

		case 'unshift-first-saved-layer': {
			const prevList = [...session.savedList]
			LL.addItemsDeterministic(
				session.savedList,
				newOp.itemSource,
				{ outerIndex: 0, innerIndex: null },
				{
					type: 'single-list-item',
					itemId: newOp.itemId,
					layerId: newOp.layerId,
					source: newOp.itemSource,
				},
			)
			saveList(session, newOp, session.savedList, onSideEffect, prevList)
			break
		}

		case 'set-vote-result': {
			const res = LL.findItemById(session.savedList, newOp.voteItemId)
			if (!res || !LL.isParentVoteItem(res.item)) return false
			const prevList = [...session.savedList]
			LL.replaceItem(session.savedList, res.index, LL.withEndingVoteState(res.item, newOp.result))
			saveList(session, newOp, session.savedList, onSideEffect, prevList)
			break
		}

		case 'add': {
			const items = LL.withTagAttribution(newOp.items, source)
			LL.addItemsDeterministic(list, source, newOp.index, ...items)
			ItemMut.tryApplyMutation(
				'added',
				items.map((item) => item.itemId),
				mutations,
			)
			if (source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			break
		}

		case 'move': {
			const { merged, modified } = LL.moveItem(list, source, newOp.itemId, newOp.newFirstItemId, newOp.cursor)
			if (modified) {
				if (merged) {
					const { item } = Obj.destrNullable(LL.findItemById(list, merged))
					if (item) {
						if (!LL.isVoteItem(item)) throw new Error('Expected parent vote item')
						ItemMut.tryApplyMutation('edited', [item.itemId], mutations)
						ItemMut.tryApplyMutation('added', [item.choices[0].itemId], mutations)
						ItemMut.tryApplyMutation(
							'moved',
							item.choices.slice(1).map((choice) => choice.itemId),
							mutations,
						)
					}
				} else {
					ItemMut.tryApplyMutation('moved', [newOp.itemId], mutations)
				}

				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}
			break
		}

		case 'swap-factions': {
			const { item: before } = Obj.destrNullable(LL.findItemById(list, newOp.itemId))
			if (!before) break
			if (!LL.swapFactions(list, newOp.itemId, source)) break
			const { item: after } = Obj.destrNullable(LL.findItemById(list, newOp.itemId))

			// maybe mirror matchups will be a thing at some point who knows
			if (!after || L.layersEqual(after.layerId, before.layerId)) break
			ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			break
		}

		case 'edit-layer': {
			const beforeEdit = LL.findItemById(list, newOp.itemId)?.item.layerId
			LL.editLayer(list, source, newOp.itemId, newOp.newLayerId)
			const afterEdit = LL.findItemById(list, newOp.itemId)?.item.layerId
			if (beforeEdit && afterEdit && beforeEdit !== afterEdit) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}
			break
		}

		case 'add-tag': {
			if (LL.addTag(list, newOp.itemId, newOp.tagId, source.type === 'manual' ? source.userId : undefined)) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'remove-tag': {
			if (LL.removeTag(list, newOp.itemId, newOp.tagId)) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		// a note is worthless without an author to attach it to, so an op from anything but a user is dropped
		case 'add-note': {
			if (source.type !== 'manual') break
			if (LL.addNote(list, newOp.itemId, { id: newOp.noteId, author: source.userId, text: newOp.text })) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'edit-note': {
			if (LL.editNote(list, newOp.itemId, newOp.noteId, newOp.text)) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'delete-note': {
			if (LL.deleteNote(list, newOp.itemId, newOp.noteId)) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'clone': {
			const { item } = Obj.destrNullable(LL.cloneAndInsertItem(list, newOp.itemId, source))
			if (item) {
				ItemMut.tryApplyMutation('added', [item.itemId], mutations)
				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}
			break
		}

		case 'configure-vote': {
			LL.configureVote(list, source, newOp.itemId, newOp.config)
			const itemRes = LL.findItemById(list, newOp.itemId)
			if (itemRes) {
				ItemMut.tryApplyMutation('edited', [newOp.itemId], mutations)
			}
			break
		}

		case 'delete': {
			const { index } = Obj.destrNullable(LL.findItemById(list, newOp.itemId))
			if (index) {
				LL.deleteItem(list, newOp.itemId)
				ItemMut.tryApplyMutation('removed', [newOp.itemId], mutations)
				if (mutations && source.type === 'manual') LL.changeGeneratedLayerAttributionInPlace(list, mutations, source.userId)
			}

			break
		}
		case 'clear':
			for (const itemId of newOp.itemIds) {
				const { index } = Obj.destrNullable(LL.findItemById(list, itemId))
				if (index) {
					LL.deleteItem(list, itemId)
					ItemMut.tryApplyMutation('removed', [itemId], mutations)
				}
			}
			break

		case 'save': {
			// a save with no net changes shouldn't request a DB write or emit a QUEUE_UPDATED, but it still closes
			// the edit window: mutations that cancelled each other out (moved back, edited back) would otherwise
			// outlive the save that acknowledged them, and nothing else clears them -- a deliberate finish-editing
			// suppresses the abandoned-draft discard. this guard lives here (not in saveList) because in-place
			// system ops -- rolls, vote results -- mutate savedList before saving, so they can't be compared
			// inside saveList; they always save.
			const queueChanged = !contentEqual(session.list, session.savedList)
			if (queueChanged) {
				saveList(session, newOp, session.list, onSideEffect)
			} else {
				closeEditWindow(session)
				onSideEffect?.({ code: 'edit-window-closed' })
			}
			break
		}

		case 'save-completed': {
			session.saving = false
			// advance the save cursor so the next QUEUE_UPDATED spans only the ops after this save
			session.lastSaveOpId = newOp.opId
			break
		}

		case 'reset-to-saved':
		case 'discard-abandoned-queue-edits': {
			session.list = [...session.savedList]
			closeEditWindow(session)
			break
		}

		default:
			assertNever(newOp)
	}

	return true
}

const BACKBURNER_OPCODES = [
	'backburner-add',
	'backburner-update',
	'backburner-remove',
	'backburner-reorder',
	'backburner-combine',
	'backburner-write-saved',
	'backburner-save',
	'backburner-reset',
	'discard-abandoned-request-edits',
] as const
type BackburnerOp = Extract<Operation, { op: (typeof BACKBURNER_OPCODES)[number] }>

export function isBackburnerOp(op: Operation): op is BackburnerOp {
	return (BACKBURNER_OPCODES as readonly string[]).includes(op.op)
}

// state.backburner/savedBackburner may alias each other after a save, so every mutation reassigns a fresh
// array rather than mutating in place
function applyBackburnerOperation(session: State, newOp: BackburnerOp, onSideEffect?: ODSM.OnSideEffect<SideEffect>): boolean {
	switch (newOp.op) {
		case 'backburner-add': {
			if (session.backburner.some((item) => item.itemId === newOp.item.itemId)) break
			session.backburner = [...session.backburner, newOp.item]
			break
		}

		case 'backburner-update': {
			const index = session.backburner.findIndex((item) => item.itemId === newOp.itemId)
			if (index === -1) break
			const next = [...session.backburner]
			next[index] = { ...next[index], filter: newOp.filter }
			session.backburner = next
			break
		}

		case 'backburner-remove': {
			session.backburner = BB.removeByIds(session.backburner, newOp.itemIds)
			break
		}

		case 'backburner-reorder': {
			const index = session.backburner.findIndex((item) => item.itemId === newOp.itemId)
			if (index === -1) break
			const next = [...session.backburner]
			const [item] = next.splice(index, 1)
			next.splice(Math.min(newOp.newIndex, next.length), 0, item)
			session.backburner = next
			break
		}

		case 'backburner-combine': {
			if (newOp.targetItemId === newOp.sourceItemId) break
			const targetIndex = session.backburner.findIndex((item) => item.itemId === newOp.targetItemId)
			const sourceIndex = session.backburner.findIndex((item) => item.itemId === newOp.sourceItemId)
			if (targetIndex === -1 || sourceIndex === -1) break
			const target = session.backburner[targetIndex]
			const source = session.backburner[sourceIndex]
			const merged = BB.mergeTemplateFilters(target.filter, source.filter)
			// conflicting filters: the dispatcher rejects this before it enters history; skipping keeps a replica no-op
			if (merged.code !== 'ok') break
			const next = [...session.backburner]
			next[targetIndex] = { ...target, filter: merged.filter }
			next.splice(sourceIndex, 1)
			session.backburner = next
			break
		}

		case 'backburner-write-saved': {
			const write = newOp.write
			const prevItems = session.savedBackburner
			const apply = (items: BB.BackburnerItem[]): BB.BackburnerItem[] => {
				switch (write.kind) {
					case 'add': {
						const without = BB.removeByIds(items, write.evictItemIds)
						if (without.some((item) => item.itemId === write.item.itemId)) return without
						return [...without, write.item]
					}
					case 'remove':
						return BB.removeByIds(items, write.itemIds)
					default:
						return assertNever(write)
				}
			}
			session.savedBackburner = apply(session.savedBackburner)
			// the committed change lands in the draft too, so in-flight GUI edits survive around it
			session.backburner = apply(session.backburner)
			onSideEffect?.({
				code: 'request-backburner-save',
				items: session.savedBackburner,
				prevItems,
				opId: newOp.opId,
				trigger: 'chat-write',
				source: newOp.source,
			})
			break
		}

		case 'backburner-save': {
			if (contentEqual(session.backburner, session.savedBackburner)) break
			const prevItems = session.savedBackburner
			session.savedBackburner = [...session.backburner]
			session.backburnerEditWindowSeqId++
			onSideEffect?.({
				code: 'request-backburner-save',
				items: session.savedBackburner,
				prevItems,
				opId: newOp.opId,
				trigger: 'user-save',
				source: { discordId: newOp.userId },
			})
			break
		}

		case 'backburner-reset':
		case 'discard-abandoned-request-edits': {
			session.backburner = [...session.savedBackburner]
			session.backburnerEditWindowSeqId++
			break
		}

		default:
			assertNever(newOp)
	}
	return true
}

function consumeBackburnerItems(
	session: State,
	newOp: Extract<Operation, { op: 'queue-item-generated' }>,
	onSideEffect?: ODSM.OnSideEffect<SideEffect>,
) {
	const itemIds = newOp.consumedBackburnerItemIds ?? []
	const prevItems = session.savedBackburner
	const nextSaved = BB.removeByIds(session.savedBackburner, itemIds)
	// a template removed since generation snapshotted it is simply no longer there to consume
	if (nextSaved.length === prevItems.length) return
	session.savedBackburner = nextSaved
	session.backburner = BB.removeByIds(session.backburner, itemIds)
	onSideEffect?.({
		code: 'request-backburner-save',
		items: session.savedBackburner,
		prevItems,
		opId: newOp.opId,
		trigger: 'consumed',
		layerId: newOp.item.type === 'single-list-item' ? newOp.item.layerId : null,
	})
}

// prevList is the saved list before this save, for the QUEUE_UPDATED app event to diff against. it defaults to the
// current savedList (correct for the `save` op, where savedList is still the last-saved list), but in-place system
// ops mutate savedList before calling saveList, so they pass a snapshot taken before their mutation.
function saveList(
	session: State,
	op: Operation,
	list: LL.List,
	onSideEffect: ODSM.OnSideEffect<SideEffect> | undefined,
	prevList: LL.List = session.savedList,
) {
	session.saving = true
	// before the empty-list bail-out: the draft this save consumed is gone either way, and leaving mutations
	// behind for the generated item to clear strands them if generation never lands
	closeEditWindow(session)
	if (list.length === 0) {
		session.requestingGeneratedQueueItem = true
		onSideEffect?.({ code: 'request-queue-item-generation' })
		return
	}
	// two arrays over the same items rather than one shared one, so a later op splicing the draft can't reach
	// into the baseline it was saved against
	session.list = [...list]
	session.savedList = [...list]
	onSideEffect?.({ code: 'request-list-save', list: session.savedList, prevList, opId: op.opId, lastSaveOpId: session.lastSaveOpId })
}

// every save path ends the edit window it committed: the draft's mutation highlights are spent, and latent ops
// authored against the old window must be discarded rather than applied on top of the saved list
function closeEditWindow(session: State) {
	session.mutations = ItemMut.initMutations()
	session.editWindowSeqId++
}

export function mergeMutations(base: ItemMut.Mutations, additions: ItemMut.Mutations): ItemMut.Mutations {
	const result = ItemMut.cloneMutations(base)
	for (const id of additions.added) ItemMut.tryApplyMutation('added', id, result)
	for (const id of additions.removed) ItemMut.tryApplyMutation('removed', id, result)
	for (const id of additions.moved) ItemMut.tryApplyMutation('moved', id, result)
	for (const id of additions.edited) ItemMut.tryApplyMutation('edited', id, result)
	return result
}

export function createNewState(list?: LL.List, backburner?: BB.BackburnerItem[]): State {
	return {
		list: list ? [...list] : [],
		editWindowSeqId: 0,
		saving: false,
		mutations: ItemMut.initMutations(),
		savedList: list ? [...list] : [],
		requestingGeneratedQueueItem: false,
		lastSaveOpId: null,
		backburner: backburner ? [...backburner] : [],
		savedBackburner: backburner ? [...backburner] : [],
		backburnerEditWindowSeqId: 0,
	}
}

export function hasMutations(session: State): boolean {
	return ItemMut.hasMutations(session.mutations)
}

export function hasBackburnerMutations(session: State): boolean {
	return !contentEqual(session.backburner, session.savedBackburner)
}

// `in` rather than a cast: the op union only carries editWindowSeqId/userId on the client-issued ops, and
// narrowing on the real union is what makes a rename of either field a compile error here rather than a
// silently-always-false check.
export function hasUserMutations(ops: Operation[], state: State, userId: USR.UserId): boolean {
	const windowSeqId = state.editWindowSeqId
	for (let i = ops.length - 1; i >= 0; i--) {
		const op = ops[i]
		if (op.op === 'save') continue
		if (!('editWindowSeqId' in op)) continue
		if (windowSeqId !== op.editWindowSeqId) break
		if ('userId' in op && op.userId === userId) return true
	}
	return false
}
