import superjson from 'superjson'
import { describe, expect, it, vi } from 'vitest'

import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Obj from '@/lib/object-utils'
import * as SE from '@/models/server-events.models'

// mirrors buildEventRows in squad-server.server.ts: the envelope lives in typed columns, the rest in the blob
function toRow(event: SE.Event): SchemaModels.ServerEvent {
	return {
		id: event.id,
		type: event.type,
		time: new Date(event.time),
		matchId: event.matchId,
		version: 1,
		appEventId: null,
		data: superjson.serialize(Obj.omit(event, ['id', 'type', 'time', 'matchId'])) as any,
	}
}

function fakeLogCtx() {
	const warn = vi.fn()
	return { ctx: { log: { warn } } as any, warn }
}

describe('fromEventRow', () => {
	it('round-trips an event through toRow -> fromEventRow', () => {
		const event: SE.Event = {
			id: 1,
			type: 'CHAT_MESSAGE',
			time: 1783460985157,
			matchId: 7,
			message: 'baf on fallujah? less than ideal lol',
			channel: { type: 'ChatSquad', teamId: 1, squadId: 3, uniqueId: 12 },
			player: '0002b8c4016847009f36c6b650b115cc',
		}
		expect(SE.fromEventRow(toRow(event))).toEqual(event)
	})

	it('reconstructs the envelope from columns rather than the blob', () => {
		const row = toRow({ id: 5, type: 'RCON_CONNECTED', time: 1783466125695, matchId: 9, reconnected: true })
		// the blob holds only the payload; id/type/time/matchId come back off the typed columns
		expect(JSON.stringify(row.data)).not.toContain('matchId')
		expect(SE.fromEventRow(row)).toEqual({ id: 5, type: 'RCON_CONNECTED', time: 1783466125695, matchId: 9, reconnected: true })
	})

	it('preserves an undefined optional through superjson rather than turning it into null', () => {
		// superjson stores `undefined` as null plus a meta marker; a null reaching the schema would fail an
		// .optional() field, so this guards the round-trip that ~4k PLAYER_CHANGED_TEAM rows in prod depend on
		const event: SE.Event = {
			id: 2,
			type: 'PLAYER_CHANGED_TEAM',
			time: 1,
			matchId: 1,
			newTeamId: 2,
			player: 'eos-1',
			source: undefined,
		}
		const row = toRow(event)
		expect((row.data as any).json.source).toBeNull()
		const back = SE.fromEventRow(row)
		expect(back).not.toBeNull()
		expect(back!).toMatchObject({ type: 'PLAYER_CHANGED_TEAM', newTeamId: 2 })
		expect((back as any).source).toBeUndefined()
	})

	it('accepts a RESET whose players predate adminGroups', () => {
		// the shape 99.4% of the player entries on prod's RESETs are actually in
		const row = toRow({
			id: 3,
			type: 'RESET',
			time: 1783466125945,
			matchId: 2,
			source: 'server-roll',
			state: {
				players: [
					{
						ids: { eos: 'eos-1', steam: '76561198857945111', username: '(idiot) -Buckethead-' },
						teamId: 1,
						squadId: 1,
						isLeader: false,
						isAdmin: false,
						role: 'Pilot',
					} as any,
				],
				squads: [],
			},
		})
		const back = SE.fromEventRow(row)
		expect(back).not.toBeNull()
		expect((back as any).state.players[0].adminGroups).toBeUndefined()
	})

	it('returns null when the persisted payload fails validation', () => {
		const row = toRow({ id: 4, type: 'PLAYER_JOINED_SQUAD', time: 1, matchId: 1, uniqueId: 3, player: 'eos-1' })
		row.data = superjson.serialize({ uniqueId: 'not-a-number', player: 'eos-1' }) as any
		expect(SE.fromEventRow(row)).toBeNull()
	})

	it('returns null when a required payload field is missing', () => {
		const row = toRow({ id: 5, type: 'RESET', time: 1, matchId: 1, source: 'server-roll', state: { players: [], squads: [] } })
		// an old row from before `state` was mandatory
		row.data = superjson.serialize({ source: 'server-roll' }) as any
		expect(SE.fromEventRow(row)).toBeNull()
	})

	it('returns null rather than throwing on an undeserializable blob', () => {
		const row = toRow({ id: 6, type: 'TEAMS_POLLED_UPDATE', time: 1, matchId: 1 })
		row.data = { json: {}, meta: { values: { x: ['not-a-real-transformer'] } } } as any
		expect(SE.fromEventRow(row)).toBeNull()
	})

	it('does not validate layerId against the layer components', () => {
		// a layer retired from the components must not erase the event that referenced it
		const row = toRow({ id: 7, type: 'MAP_SET', time: 1, matchId: 1, layerId: 'RETIRED-MOD-LAYER:XX:YY' as any })
		expect(SE.fromEventRow(row)).toMatchObject({ type: 'MAP_SET', layerId: 'RETIRED-MOD-LAYER:XX:YY' })
	})

	describe('rows written with `weapon`', () => {
		const legacy = (type: 'PLAYER_DIED' | 'PLAYER_WOUNDED', damage: number, weapon: string | null) =>
			toRow({ id: 8, type, time: 1, matchId: 1, victim: 'eos-1', attacker: 'eos-2', variant: 'normal', damage, weapon } as any)

		it('reads a death from wounds, logged with its damage unsigned and the victim pawn as its cause', () => {
			expect(SE.fromEventRow(legacy('PLAYER_DIED', 300, 'BP_Soldier_RU_Medic'))).toMatchObject({
				damage: -300,
				deathVariant: 'diedOfWounds',
				damageSource: 'BP_Soldier_RU_Medic',
			})
		})

		it('reads a 300-damage hit from a weapon as a kill', () => {
			const event = SE.fromEventRow(legacy('PLAYER_DIED', 300, 'BP_RPG7_Tandem_Heat_Proj2'))
			expect(event).toMatchObject({ damage: 300, deathVariant: 'killed', damageSource: 'BP_RPG7_Tandem_Heat_Proj2' })
			expect(event).not.toHaveProperty('weapon')
		})

		it('reads a wound', () => {
			const event = SE.fromEventRow(legacy('PLAYER_WOUNDED', 60, null))
			expect(event).toMatchObject({ damageSource: null })
			expect(event).not.toHaveProperty('deathVariant')
		})
	})
})

describe('fromEventRows', () => {
	it('drops unparseable rows, keeps the rest, and logs the drop', () => {
		const good = toRow({ id: 1, type: 'PLAYER_JOINED_SQUAD', time: 1, matchId: 1, uniqueId: 3, player: 'eos-1' })
		const bad = toRow({ id: 2, type: 'PLAYER_JOINED_SQUAD', time: 2, matchId: 1, uniqueId: 4, player: 'eos-2' })
		bad.data = superjson.serialize({ uniqueId: 'nope' }) as any
		const { ctx, warn } = fakeLogCtx()

		const events = SE.fromEventRows(ctx, [good, bad])

		expect(events.map((e) => e.id)).toEqual([1])
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toEqual({
			dropped: [{ id: 2, type: 'PLAYER_JOINED_SQUAD', error: expect.stringContaining('uniqueId') }],
		})
	})

	it('stays quiet when every row parses', () => {
		const { ctx, warn } = fakeLogCtx()
		const events = SE.fromEventRows(ctx, [toRow({ id: 1, type: 'TEAMS_POLLED_UPDATE', time: 1, matchId: 1 })])
		expect(events).toHaveLength(1)
		expect(warn).not.toHaveBeenCalled()
	})
})
