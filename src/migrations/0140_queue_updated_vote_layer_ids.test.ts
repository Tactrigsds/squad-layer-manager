import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import * as AppEvents from '@/models/app-events.models'
import type * as LL from '@/models/layer-list.models'
import * as L from '@/models/layer.models'

import { up } from './0140_queue_updated_vote_layer_ids'

const FIRST = L.defaultLayerId()
const SECOND = L.swapFactionsInId(FIRST)

function voteItem(layerId: L.LayerId, winner = false): LL.VoteItem {
	return {
		type: 'vote-list-item',
		itemId: 'vote0001',
		layerId,
		source: { type: 'gameserver' },
		choices: [
			{ type: 'single-list-item', itemId: 'choice001', layerId: FIRST, source: { type: 'gameserver' } },
			{ type: 'single-list-item', itemId: 'choice002', layerId: SECOND, source: { type: 'gameserver' } },
		],
		...(winner
			? {
					endingVoteState: {
						code: 'ended:winner' as const,
						winnerId: 'choice002',
						choiceIds: ['choice001', 'choice002'],
						itemId: 'vote0001',
						deadline: 0,
						votes: [],
						voterType: 'public' as const,
					},
				}
			: {}),
	}
}

function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE appEvents (
		id TEXT PRIMARY KEY, type TEXT NOT NULL, time INTEGER NOT NULL, actorType TEXT NOT NULL, actorUserId TEXT,
		actorPlayerId TEXT, actorPluginId TEXT, serverId TEXT, matchId INTEGER, causeId TEXT, instanceId TEXT,
		feedVisible INTEGER, version INTEGER, data TEXT NOT NULL
	)`)
	return db
}

function insert(db: InstanceType<typeof DatabaseConstructor>, event: AppEvents.AppEvent) {
	const row = AppEvents.toRow(event, (_path, value) => value)
	db.prepare(
		`INSERT INTO appEvents (id, type, time, actorType, actorUserId, serverId, matchId, feedVisible, version, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
	).run(
		row.id,
		row.type,
		row.time.getTime(),
		row.actorType,
		row.actorUserId?.toString() ?? null,
		row.serverId,
		row.matchId,
		JSON.stringify(row.data),
	)
}

function read(db: InstanceType<typeof DatabaseConstructor>, id: string) {
	const row = db.prepare(`SELECT * FROM appEvents WHERE id = ?`).get(id) as Record<string, any>
	const event = AppEvents.fromRow({
		...row,
		time: new Date(row.time),
		actorUserId: row.actorUserId === null ? null : BigInt(row.actorUserId),
		data: JSON.parse(row.data),
	} as any)
	return { event, feedVisible: row.feedVisible as number | null }
}

function queueUpdated(prevList: LL.List, list: LL.List) {
	return AppEvents.create<AppEvents.QueueUpdated>({
		type: 'QUEUE_UPDATED',
		actor: { type: 'slm-user', userId: 5n },
		serverId: 'server-1',
		matchId: 1,
		causeId: null,
		trigger: 'user-edit',
		ops: [],
		prevList,
		list,
		save: { force: false, overrodeEditors: [6n] },
	})
}

describe('0140_queue_updated_vote_layer_ids', () => {
	test('gives an undecided vote item its first choice back, and leaves every other row alone', async () => {
		const db = makeDb()
		const broken = queueUpdated([voteItem(SECOND)], [voteItem(SECOND, true)])
		const decided = queueUpdated([voteItem(FIRST)], [voteItem(SECOND, true)])
		const other = AppEvents.create<AppEvents.MatchEnded>({
			type: 'MATCH_ENDED',
			actor: { type: 'system' },
			serverId: 'server-1',
			matchId: 1,
			causeId: null,
		})
		insert(db, broken)
		insert(db, decided)
		insert(db, other)
		const untouchedData = db.prepare(`SELECT id, data FROM appEvents WHERE id != ?`).all(broken.id)
		expect(read(db, broken.id).event).toBeNull()

		await up(db)

		const repaired = read(db, broken.id)
		expect(repaired.feedVisible).toBeNull()
		const event = repaired.event as AppEvents.QueueUpdated
		expect(event.prevList[0].layerId).toBe(FIRST)
		expect(event.list[0].layerId).toBe(SECOND)
		expect(event.save?.overrodeEditors).toEqual([6n])
		expect(db.prepare(`SELECT id, data FROM appEvents WHERE id != ?`).all(broken.id)).toEqual(untouchedData)
		expect(read(db, decided.id).feedVisible).toBe(1)

		const afterFirst = db.prepare(`SELECT data FROM appEvents WHERE id = ?`).get(broken.id)
		await up(db)
		expect(db.prepare(`SELECT data FROM appEvents WHERE id = ?`).get(broken.id)).toEqual(afterFirst)
	})
})
