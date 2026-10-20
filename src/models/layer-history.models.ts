/**
 * The history of one layer queue item: the edit sessions that touched it, the votes it ran, and the matches it lived
 * through. An edit session is the span of queue ops one QUEUE_UPDATED commits; its log is rebuilt by replaying those
 * ops over the queue as it stood before the save, since the ops alone don't say where an item was or what it held.
 */
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object-utils'
import { assertNever } from '@/lib/type-guards'
import * as AppEvents from '@/models/app-events.models'
import * as LL from '@/models/layer-list.models'
import type * as L from '@/models/layer.models'
import * as SLL from '@/models/shared-layer-list.models'

// one op of an edit session. `itemId` is the item the op acted on, `topItemId` the top-level item holding it, which
// differ for a vote choice. `layerIds` is the item's layers after the op, or before it for a removal.
export type SessionLogEntry = {
	opId: string
	actor: AppEvents.Actor
	itemId: LL.ItemId | null
	topItemId: LL.ItemId | null
	layerIds: L.LayerId[]
	isVote: boolean
} & (
	| { kind: 'added'; index: number }
	| { kind: 'cloned'; index: number }
	| { kind: 'generated'; index: number }
	| { kind: 'synced'; index: number }
	| { kind: 'removed' }
	| { kind: 'advanced' }
	| { kind: 'moved'; fromIndex: number; toIndex: number }
	| { kind: 'factions-swapped' }
	| { kind: 'layer-edited'; prevLayerIds: L.LayerId[] }
	| { kind: 'tag-added' | 'tag-removed'; tagId: string }
	| { kind: 'note-added' | 'note-edited'; text: string }
	| { kind: 'note-deleted' }
	| { kind: 'vote-configured' }
	| { kind: 'vote-result' }
	| { kind: 'reverted'; count: number }
	// the draft was thrown away: by its editor (reset to saved), or by SLM once every editor left. The entries it
	// held are dropped from the log, since none of them reached the queue.
	| { kind: 'discarded'; count: number }
)

type Located = { item: LL.Item; top: LL.Item; topIndex: number }

function locate(list: LL.List, itemId: LL.ItemId): Located | undefined {
	const found = LL.findItemById(list, itemId)
	if (!found) return undefined
	const topIndex = found.index.outerIndex
	return { item: found.item, top: list[topIndex], topIndex }
}

function layerIdsOf(item: LL.Item): L.LayerId[] {
	return [...LL.getAllItemLayerIds(item)]
}

function opActor(op: SLL.Operation): AppEvents.Actor {
	if (op.op === 'unshift-first-saved-layer' && op.externalSource?.type === 'player') {
		return { type: 'ingame-user', playerId: op.externalSource.playerId }
	}
	return AppEvents.opActor(op)
}

/**
 * Each op of a QUEUE_UPDATED as it happened, in order. Session bookkeeping (saves, edit window resets that undo
 * nothing, backburner ops) is left out. Ops are replayed with their edit window ids stripped: the replay starts a
 * fresh session, and only ops the live session accepted were recorded.
 */
export function queueSessionLog(e: AppEvents.QueueUpdated): SessionLogEntry[] {
	let state = SLL.createNewState(e.prevList, undefined, { generateWhenEmpty: false })
	const entries: SessionLogEntry[] = []
	// where the current draft's entries start: everything before it was committed by a save
	let draftStart = 0

	for (const op of e.ops) {
		const before = state
		const next: SLL.State = {
			...before,
			list: [...before.list],
			savedList: [...before.savedList],
			mutations: ItemMut.cloneMutations(before.mutations),
		}
		const { editWindowSeqId: _, ...unwindowed } = op as SLL.Operation & { editWindowSeqId?: number }
		try {
			SLL.applyOperation(next, unwindowed as SLL.Operation)
			state = next
		} catch {
			// a replay can drift from the live session (a revert of an op from an earlier session has no record here),
			// so an op that no longer applies is still described from what it carries
		}
		const actor = opActor(op)
		const base = { opId: op.opId, actor }
		const at = (list: LL.List, itemId: LL.ItemId) => locate(list, itemId)
		const itemEntry = (loc: Located | undefined, itemId: LL.ItemId) => ({
			...base,
			itemId,
			topItemId: loc?.top.itemId ?? itemId,
			layerIds: loc ? layerIdsOf(loc.item) : [],
			isVote: loc ? LL.isVoteItem(loc.item) : false,
		})

		switch (op.op) {
			case 'add':
				for (const item of op.items) {
					const loc = at(state.list, item.itemId)
					entries.push({ ...itemEntry(loc, item.itemId), kind: 'added', index: loc?.topIndex ?? 0 })
				}
				break
			case 'queue-item-generated': {
				const loc = at(state.savedList, op.item.itemId)
				entries.push({ ...itemEntry(loc, op.item.itemId), kind: 'generated', index: loc?.topIndex ?? 0 })
				break
			}
			case 'unshift-first-saved-layer': {
				const loc = at(state.savedList, op.itemId)
				entries.push({ ...itemEntry(loc, op.itemId), kind: 'synced', index: 0 })
				break
			}
			case 'shift-first-saved-layer': {
				const top = before.savedList[0]
				if (!top) break
				entries.push({ ...itemEntry({ item: top, top, topIndex: 0 }, top.itemId), kind: 'advanced' })
				break
			}
			case 'clone': {
				// the clone is the only item in the list after the op that wasn't before it
				const prevIds = new Set([...LL.iterItems(...before.list)].map(({ item }) => item.itemId))
				const clone = [...LL.iterItems(...state.list)].find(({ item }) => !prevIds.has(item.itemId))
				if (!clone) break
				const loc = at(state.list, clone.item.itemId)
				entries.push({ ...itemEntry(loc, clone.item.itemId), kind: 'cloned', index: loc?.topIndex ?? 0 })
				break
			}
			case 'delete':
				entries.push({ ...itemEntry(at(before.list, op.itemId), op.itemId), kind: 'removed' })
				break
			case 'clear':
				for (const itemId of op.itemIds) entries.push({ ...itemEntry(at(before.list, itemId), itemId), kind: 'removed' })
				break
			case 'move': {
				const from = at(before.list, op.itemId)
				const to = at(state.list, op.itemId)
				if (!from || !to || (from.topIndex === to.topIndex && from.top.itemId === to.top.itemId)) break
				entries.push({ ...itemEntry(to, op.itemId), kind: 'moved', fromIndex: from.topIndex, toIndex: to.topIndex })
				break
			}
			case 'swap-factions':
				entries.push({ ...itemEntry(at(state.list, op.itemId), op.itemId), kind: 'factions-swapped' })
				break
			case 'edit-layer': {
				const from = at(before.list, op.itemId)
				entries.push({
					...itemEntry(at(state.list, op.itemId), op.itemId),
					kind: 'layer-edited',
					prevLayerIds: from ? layerIdsOf(from.item) : [],
				})
				break
			}
			case 'add-tag':
			case 'remove-tag':
				entries.push({
					...itemEntry(at(state.list, op.itemId), op.itemId),
					kind: op.op === 'add-tag' ? 'tag-added' : 'tag-removed',
					tagId: op.tagId,
				})
				break
			case 'add-note':
			case 'edit-note':
				entries.push({
					...itemEntry(at(state.list, op.itemId), op.itemId),
					kind: op.op === 'add-note' ? 'note-added' : 'note-edited',
					text: op.text,
				})
				break
			case 'delete-note':
				entries.push({ ...itemEntry(at(state.list, op.itemId), op.itemId), kind: 'note-deleted' })
				break
			case 'configure-vote':
				entries.push({ ...itemEntry(at(state.list, op.itemId), op.itemId), kind: 'vote-configured' })
				break
			case 'set-vote-result':
				entries.push({ ...itemEntry(at(state.savedList, op.voteItemId), op.voteItemId), kind: 'vote-result' })
				break
			case 'revert':
				entries.push({ ...base, itemId: null, topItemId: null, layerIds: [], isVote: false, kind: 'reverted', count: op.opIds.length })
				break
			case 'reset-to-saved':
			case 'discard-abandoned-queue-edits': {
				const dropped = entries.splice(draftStart).length
				if (dropped === 0) break
				// a run of drafts thrown away by the same hand reads as one line
				const last = entries.at(-1)
				if (last?.kind === 'discarded' && Obj.deepEqual(last.actor, actor)) {
					entries[entries.length - 1] = { ...last, count: last.count + dropped }
				} else {
					entries.push({ ...base, itemId: null, topItemId: null, layerIds: [], isVote: false, kind: 'discarded', count: dropped })
				}
				break
			}
			case 'init':
			case 'save':
			case 'save-completed':
			case 'discard-abandoned-request-edits':
			case 'backburner-add':
			case 'backburner-update':
			case 'backburner-remove':
			case 'backburner-reorder':
			case 'backburner-combine':
			case 'backburner-write-saved':
			case 'backburner-save':
			case 'backburner-reset':
				break
			default:
				assertNever(op)
		}
		if (state.editWindowSeqId !== before.editWindowSeqId) draftStart = entries.length
	}
	return entries
}

// whether an entry touched the item, or a choice inside it
export function entryTouches(entry: SessionLogEntry, itemId: LL.ItemId): boolean {
	return entry.itemId === itemId || entry.topItemId === itemId
}
