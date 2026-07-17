import * as AppEvents from '@/models/app-events.models'
import type * as LL from '@/models/layer-list.models'
import * as SLL from '@/models/shared-layer-list'
import superjson from 'superjson'
import { describe, expect, it } from 'vitest'

describe('app-events persistence', () => {
	it('round-trips an event through toRow -> fromRow (incl. bigint actor)', () => {
		const e = AppEvents.create<AppEvents.PlayerWarned>({
			type: 'PLAYER_WARNED',
			actor: { type: 'slm-user', userId: 42n },
			serverId: 's1',
			matchId: 3,
			causeId: null,
			message: 'stop',
			targets: ['eos-1', 'eos-2'],
		})
		const back = AppEvents.fromRow(AppEvents.toRow(e) as any)
		expect(back).toEqual(e)
	})

	it('reconstructs a system-actor / ingame-user actor from columns', () => {
		const e = AppEvents.create<AppEvents.MapSet>({
			type: 'MAP_SET',
			actor: { type: 'system' },
			serverId: 's1',
			matchId: 1,
			causeId: 'cause-1',
			layerId: 'GD-RAAS-V1:USA-CA:RGF-CA',
			reason: 'override',
			overrode: { type: 'player', playerId: 'eos-9' },
		})
		const back = AppEvents.fromRow(AppEvents.toRow(e) as any)
		expect(back).toEqual(e)
	})

	it('returns null when the persisted payload fails validation', () => {
		const e = AppEvents.create<AppEvents.VoteStarted>({
			type: 'VOTE_STARTED',
			actor: { type: 'system' },
			serverId: 's1',
			matchId: 1,
			causeId: null,
			choiceCount: 3,
		})
		const row = AppEvents.toRow(e) as any
		// simulate an old/corrupt row whose payload no longer matches the schema
		row.data = superjson.serialize({ choiceCount: 'not-a-number' })
		expect(AppEvents.fromRow(row)).toBeNull()
	})

	it('returns null when a required payload field is missing', () => {
		const e = AppEvents.create<AppEvents.PlayerWarned>({
			type: 'PLAYER_WARNED',
			actor: { type: 'slm-user', userId: 1n },
			serverId: 's1',
			matchId: 1,
			causeId: null,
			message: 'stop',
			targets: ['eos-1'],
		})
		const row = AppEvents.toRow(e) as any
		// an old row from before `targets` existed
		row.data = superjson.serialize({ message: 'stop' })
		expect(AppEvents.fromRow(row)).toBeNull()
	})

	it('reads a backup row from before pre-migration backups existed as a periodic one', () => {
		const e = AppEvents.create<AppEvents.BackupCreated>({
			type: 'BACKUP_CREATED',
			actor: { type: 'system' },
			serverId: null,
			matchId: null,
			causeId: null,
			fileName: 'slm-backup-db-20260713-134504.sqlite3.gz',
			sizeBytes: 1024,
			reason: 'periodic',
			durationMs: 80,
		})
		const row = AppEvents.toRow(e) as any
		// an old row, written before the reason was recorded. Every one of them is a periodic backup: there was no
		// other kind. Dropping them (fromRow returns null on a parse failure) would put holes in the audit log.
		row.data = superjson.serialize({ fileName: e.fileName, sizeBytes: e.sizeBytes, durationMs: e.durationMs })
		expect(AppEvents.fromRow(row)).toEqual(e)
	})

	it('round-trips a settings diff, including a path that had no previous value', () => {
		const e = AppEvents.create<AppEvents.SettingsUpdated>({
			type: 'SETTINGS_UPDATED',
			actor: { type: 'slm-user', userId: 7n },
			serverId: null,
			matchId: null,
			causeId: null,
			changes: [
				{ path: 'layerQueue.lowQueueWarningThreshold', from: 3, to: 5 },
				{ path: 'connections.rcon.password', from: AppEvents.REDACTED_SETTING, to: AppEvents.REDACTED_SETTING },
				// a newly-set path has no `from` at all, which is the case superjson has to preserve
				{ path: 'vote.defaultVoteDisplayProps', from: undefined, to: ['layer'] },
			],
		})
		const back = AppEvents.fromRow(AppEvents.toRow(e) as any)
		expect(back).toEqual(e)
		expect((back as AppEvents.SettingsUpdated).changes?.[2]).toEqual({
			path: 'vote.defaultVoteDisplayProps',
			from: undefined,
			to: ['layer'],
		})
	})

	it('redacts connection credentials on the way to the database, even if the caller did not', () => {
		const e = AppEvents.create<AppEvents.SettingsUpdated>({
			type: 'SETTINGS_UPDATED',
			actor: { type: 'slm-user', userId: 7n },
			serverId: 's1',
			matchId: null,
			causeId: null,
			changes: [
				{ path: 'connections.rcon.password', from: 'old-rcon-pw', to: 'new-rcon-pw' },
				{ path: 'connections.token', from: 'old-token', to: 'new-token' },
				{ path: 'connections', from: { rcon: { password: 'whole-object' } }, to: {} },
				{ path: 'queue.preferredLength', from: 12, to: 8 },
			],
		})
		const persisted = AppEvents.fromRow(AppEvents.toRow(e) as any) as AppEvents.SettingsUpdated
		expect(persisted.changes).toEqual([
			{ path: 'connections.rcon.password', from: AppEvents.REDACTED_SETTING, to: AppEvents.REDACTED_SETTING },
			{ path: 'connections.token', from: AppEvents.REDACTED_SETTING, to: AppEvents.REDACTED_SETTING },
			{ path: 'connections', from: AppEvents.REDACTED_SETTING, to: AppEvents.REDACTED_SETTING },
			// non-sensitive paths keep their values
			{ path: 'queue.preferredLength', from: 12, to: 8 },
		])
		// belt and braces: no credential value survives anywhere in the serialized blob (the paths do, by design)
		const blob = JSON.stringify(AppEvents.toRow(e).data)
		for (const secret of ['old-rcon-pw', 'new-rcon-pw', 'old-token', 'new-token', 'whole-object']) {
			expect(blob).not.toContain(secret)
		}
	})

	it('parses an old QUEUE_UPDATED row that predates the save metadata', () => {
		const e = AppEvents.create<AppEvents.QueueUpdated>({
			type: 'QUEUE_UPDATED',
			actor: { type: 'slm-user', userId: 1n },
			serverId: 's1',
			matchId: 1,
			causeId: null,
			trigger: 'user-edit',
			ops: [],
			prevList: [],
			list: [],
		})
		const back = AppEvents.fromRow(AppEvents.toRow(e) as any) as AppEvents.QueueUpdated
		expect(back).not.toBeNull()
		expect(back.save).toBeUndefined()
	})
})

describe('summarizeQueueChanges', () => {
	const ALICE = 1n
	const BOB = 2n
	const LAYER_A = 'GD-RAAS-V1:USA-CA:RGF-CA'
	const LAYER_B = 'YE-RAAS-V1:USA-CA:RGF-CA'
	const LAYER_C = 'NV-RAAS-V1:USA-CA:RGF-CA'

	const item = (itemId: string, layerId: string, userId?: bigint): LL.Item => ({
		type: 'single-list-item',
		itemId,
		layerId,
		source: userId !== undefined ? { type: 'manual', userId } : { type: 'generated' },
	})

	const clientOp = (op: Partial<SLL.Operation> & { op: string }, userId: bigint) =>
		({ opId: SLL.createOpId(), userId, editWindowSeqId: 0, ...op }) as SLL.Operation

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

	it('attributes an add to the user on the item source, and a delete to the user whose op removed it', () => {
		const changes = AppEvents.summarizeQueueChanges(event({
			prevList: [item('i1', LAYER_A, ALICE)],
			list: [item('i2', LAYER_B, BOB)],
			ops: [
				clientOp({ op: 'delete', itemId: 'i1' }, BOB),
				clientOp({ op: 'add', items: [item('i2', LAYER_B, BOB)], index: { outerIndex: 0, innerIndex: null } } as any, BOB),
			],
		}))
		expect(changes).toEqual([
			{ kind: 'added', itemId: 'i2', index: 0, layerIds: [LAYER_B], isVote: false, actor: { type: 'slm-user', userId: BOB } },
			{ kind: 'removed', itemId: 'i1', layerIds: [LAYER_A], isVote: false, actor: { type: 'slm-user', userId: BOB } },
		])
	})

	it('reports an edit against the layer it replaced', () => {
		const changes = AppEvents.summarizeQueueChanges(event({
			prevList: [item('i1', LAYER_A, ALICE)],
			list: [item('i1', LAYER_B, ALICE)],
			ops: [clientOp({ op: 'edit-layer', itemId: 'i1', newLayerId: LAYER_B } as any, BOB)],
		}))
		expect(changes).toEqual([
			{
				kind: 'edited',
				itemId: 'i1',
				layerIds: [LAYER_B],
				prevLayerIds: [LAYER_A],
				isVote: false,
				actor: { type: 'slm-user', userId: BOB },
			},
		])
	})

	it('reports only the item that moved, not the ones it shifted along', () => {
		const changes = AppEvents.summarizeQueueChanges(event({
			prevList: [item('i1', LAYER_A), item('i2', LAYER_B), item('i3', LAYER_C)],
			list: [item('i3', LAYER_C), item('i1', LAYER_A), item('i2', LAYER_B)],
			ops: [clientOp({ op: 'move', itemId: 'i3' } as any, ALICE)],
		}))
		expect(changes).toEqual([
			{
				kind: 'moved',
				itemId: 'i3',
				layerIds: [LAYER_C],
				isVote: false,
				fromIndex: 2,
				toIndex: 0,
				actor: { type: 'slm-user', userId: ALICE },
			},
		])
	})

	it('ignores churn that cancelled out before the save', () => {
		const list = [item('i1', LAYER_A, ALICE)]
		const changes = AppEvents.summarizeQueueChanges(event({
			prevList: list,
			list,
			ops: [
				clientOp({ op: 'add', items: [item('i9', LAYER_C, BOB)], index: { outerIndex: 1, innerIndex: null } } as any, BOB),
				clientOp({ op: 'delete', itemId: 'i9' }, BOB),
			],
		}))
		expect(changes).toEqual([])
	})

	it('attributes a roll (no userId on the op) to the system', () => {
		const changes = AppEvents.summarizeQueueChanges(event({
			trigger: 'roll',
			actor: { type: 'system' },
			prevList: [item('i1', LAYER_A), item('i2', LAYER_B)],
			list: [item('i2', LAYER_B)],
			ops: [{ op: 'shift-first-saved-layer', opId: SLL.createOpId() }],
		}))
		expect(changes).toEqual([
			{ kind: 'removed', itemId: 'i1', layerIds: [LAYER_A], isVote: false, actor: { type: 'system' } },
		])
	})
})
