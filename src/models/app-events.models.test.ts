import * as AppEvents from '@/models/app-events.models'
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
})
