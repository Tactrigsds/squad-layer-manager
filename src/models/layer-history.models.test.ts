import { describe, expect, it } from 'vitest'

import * as AppEvents from '@/models/app-events.models'
import * as LH from '@/models/layer-history.models'
import type * as LL from '@/models/layer-list.models'
import * as L from '@/models/layer.models'
import * as SLL from '@/models/shared-layer-list.models'

describe('queueSessionLog', () => {
	const ALICE = 1n
	const BOB = 2n
	const LAYER_A = L.fromLayerText('Gorodok_RAAS_v1:USA+CombinedArms:RGF+CombinedArms')!
	const LAYER_B = L.fromLayerText('Yehorivka_RAAS_v1:USA+CombinedArms:RGF+CombinedArms')!
	const LAYER_C = L.fromLayerText('Narva_RAAS_v1:USA+CombinedArms:RGF+CombinedArms')!

	const item = (itemId: string, layerId: L.LayerId, userId: bigint): LL.Item => ({
		type: 'single-list-item',
		itemId,
		layerId,
		source: { type: 'manual', userId },
	})

	// the live session's edit window ids, which the replay has to ignore
	const clientOp = (op: Partial<SLL.Operation> & { op: string }, userId: bigint, editWindowSeqId = 7) =>
		({ opId: SLL.createOpId(), userId, editWindowSeqId, ...op }) as SLL.Operation
	const serverOp = (op: Partial<SLL.Operation> & { op: string }) => ({ opId: SLL.createOpId(), ...op }) as SLL.Operation

	const event = (fields: Partial<AppEvents.QueueUpdated>) =>
		AppEvents.create<AppEvents.QueueUpdated>({
			type: 'QUEUE_UPDATED',
			actor: { type: 'slm-user', userId: ALICE },
			serverId: 's1',
			matchId: 1,
			causeId: null,
			trigger: 'user-edit',
			ops: [],
			prevList: [],
			list: [],
			...fields,
		})

	const without = (entries: LH.SessionLogEntry[]) => entries.map(({ opId: _, ...rest }) => rest)

	it('replays each op in order, with the positions the queue had at the time and whoever made it', () => {
		const log = LH.queueSessionLog(
			event({
				prevList: [item('i1', LAYER_A, ALICE), item('i2', LAYER_B, ALICE), item('i3', LAYER_C, ALICE)],
				ops: [
					clientOp(
						{
							op: 'move',
							itemId: 'i3',
							newFirstItemId: 'v1',
							cursor: { type: 'item-relative', itemId: 'i1', position: 'before' },
						} as Partial<SLL.Operation> & { op: string },
						BOB,
					),
					clientOp({ op: 'delete', itemId: 'i2' } as Partial<SLL.Operation> & { op: string }, ALICE),
					clientOp({ op: 'save' }, ALICE),
				],
			}),
		)
		expect(without(log)).toEqual([
			{
				kind: 'moved',
				actor: { type: 'slm-user', userId: BOB },
				itemId: 'i3',
				topItemId: 'i3',
				layerIds: [LAYER_C],
				isVote: false,
				fromIndex: 2,
				toIndex: 0,
			},
			{ kind: 'removed', actor: { type: 'slm-user', userId: ALICE }, itemId: 'i2', topItemId: 'i2', layerIds: [LAYER_B], isVote: false },
		])
	})

	it('drops the edits of a draft that was thrown away, leaving one line for each run of them', () => {
		const add = (itemId: string, layerId: L.LayerId, userId: bigint) =>
			clientOp(
				{ op: 'add', items: [item(itemId, layerId, userId)], index: { outerIndex: 0, innerIndex: null } } as Partial<SLL.Operation> & {
					op: string
				},
				userId,
			)
		const log = LH.queueSessionLog(
			event({
				prevList: [item('i1', LAYER_A, ALICE)],
				ops: [
					add('d1', LAYER_B, BOB),
					serverOp({ op: 'discard-abandoned-queue-edits' }),
					add('d2', LAYER_B, BOB),
					add('d3', LAYER_C, BOB),
					serverOp({ op: 'discard-abandoned-queue-edits' }),
					add('i2', LAYER_C, ALICE),
					clientOp({ op: 'save' }, ALICE),
				],
			}),
		)
		expect(log.map((entry) => [entry.kind, entry.itemId])).toEqual([
			['discarded', null],
			['added', 'i2'],
		])
		expect(log[0]).toMatchObject({ kind: 'discarded', count: 3, actor: { type: 'system' } })
	})
})
