import type * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models'
import type * as SE from '@/models/server-events.models'
import type * as SM from '@/models/squad.models'
import { describe, expect, it } from 'vitest'

function makePlayer(eos: string, opts: Partial<SM.Player> = {}): SM.Player {
	return {
		ids: { eos, playerController: `ctrl_${eos}`, username: eos },
		teamId: 1,
		squadId: null,
		isLeader: false,
		isAdmin: false,
		role: 'Rifleman_01',
		...opts,
	}
}

function makeSquad(squadId: number, teamId: SM.TeamId, creatorEos: string, uniqueId: number): SM.UniqueSquad {
	return { squadId, teamId, creator: creatorEos, uniqueId, squadName: `Squad ${squadId}`, locked: false }
}

function warnAppEvent(targets: SM.PlayerId[], message = 'stop'): CHAT.AppFeedEvent {
	return {
		type: 'APP_EVENT',
		appEvent: {
			type: 'PLAYER_WARNED',
			id: 'app-1',
			time: 100,
			actor: { type: 'slm-user', userId: 1n },
			serverId: 's1',
			matchId: 1,
			causeId: null,
			instanceId: null,
			message,
			targets,
		} satisfies AppEvents.PlayerWarned,
	}
}

function warnServerEvent(player: SM.PlayerId, reason: string, id: number, source?: SE.PlayerWarned['source']): SE.PlayerWarned {
	return { type: 'PLAYER_WARNED', id, time: 100 + id, matchId: 1, reason, player, source }
}

describe('chat.models application-event collapse', () => {
	function seededState(players: SM.Player[]): CHAT.ChatState {
		const state = CHAT.getInitialChatState()
		state.interpolatedState.players = players
		return state
	}

	it('collapses an attributed warn into its app-event entry', () => {
		const state = seededState([makePlayer('eos-1')])
		CHAT.handleEvent(state, warnAppEvent(['eos-1']))
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, { type: 'event', id: 'app-1' }))

		expect(state.eventBuffer).toHaveLength(1)
		const entry = state.eventBuffer[0]
		expect(entry.type).toBe('APP_EVENT')
		if (entry.type !== 'APP_EVENT') throw new Error('unreachable')
		expect(entry.collapsed).toHaveLength(1)
		expect(entry.targetPlayers.map(p => p.ids.eos)).toEqual(['eos-1'])
	})

	it('aggregates multiple warns under one entry', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2')])
		CHAT.handleEvent(state, warnAppEvent(['eos-1', 'eos-2']))
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, { type: 'event', id: 'app-1' }))
		CHAT.handleEvent(state, warnServerEvent('eos-2', 'stop', 2, { type: 'event', id: 'app-1' }))

		expect(state.eventBuffer).toHaveLength(1)
		const entry = state.eventBuffer[0]
		if (entry.type !== 'APP_EVENT') throw new Error('expected APP_EVENT')
		expect(entry.collapsed).toHaveLength(2)
	})

	it('renders a warn standalone when it has no app-event source', () => {
		const state = seededState([makePlayer('eos-1')])
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1))

		expect(state.eventBuffer).toHaveLength(1)
		expect(state.eventBuffer[0].type).toBe('PLAYER_WARNED')
	})

	it('falls back to standalone when the referenced app event is not buffered', () => {
		const state = seededState([makePlayer('eos-1')])
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, { type: 'event', id: 'missing' }))

		expect(state.eventBuffer).toHaveLength(1)
		expect(state.eventBuffer[0].type).toBe('PLAYER_WARNED')
	})

	it('collapses a non-warn attributed event (PLAYER_CHANGED_TEAM) into its app entry', () => {
		const state = seededState([makePlayer('eos-1')])
		const appEvent: CHAT.AppFeedEvent = {
			type: 'APP_EVENT',
			appEvent: {
				type: 'TEAM_CHANGE_FORCED',
				id: 'app-1',
				time: 100,
				actor: { type: 'slm-user', userId: 1n },
				serverId: 's1',
				matchId: 1,
				causeId: null,
				instanceId: null,
				targets: ['eos-1'],
			} satisfies AppEvents.TeamChangeForced,
		}
		CHAT.handleEvent(state, appEvent)
		const changed: SE.PlayerChangedTeam = {
			type: 'PLAYER_CHANGED_TEAM',
			id: 1,
			time: 101,
			matchId: 1,
			player: 'eos-1',
			newTeamId: 2,
			source: { type: 'event', id: 'app-1' },
		}
		CHAT.handleEvent(state, changed)

		expect(state.eventBuffer).toHaveLength(1)
		const entry = state.eventBuffer[0]
		if (entry.type !== 'APP_EVENT') throw new Error('expected APP_EVENT')
		expect(entry.collapsed).toHaveLength(1)
		expect(entry.targetPlayers.map(p => p.ids.eos)).toEqual(['eos-1'])
	})

	it('enriches a SQUAD_DISBANDED app event with its members as targetPlayers', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2')])
		const appEvent: CHAT.AppFeedEvent = {
			type: 'APP_EVENT',
			appEvent: {
				type: 'SQUAD_DISBANDED',
				id: 'app-1',
				time: 100,
				actor: { type: 'system' },
				serverId: 's1',
				matchId: 1,
				causeId: null,
				instanceId: null,
				teamId: 1,
				squadId: 3,
				squadName: 'Alpha',
				members: ['eos-1', 'eos-2'],
			} satisfies AppEvents.SquadDisbanded,
		}
		CHAT.handleEvent(state, appEvent)

		const entry = state.eventBuffer[0]
		if (entry.type !== 'APP_EVENT') throw new Error('expected APP_EVENT')
		expect(entry.targetPlayers.map(p => p.ids.eos)).toEqual(['eos-1', 'eos-2'])
	})

	it('resolves actorPlayer for an in-game-user actor (external queue sync)', () => {
		const state = seededState([makePlayer('eos-1')])
		const appEvent: CHAT.AppFeedEvent = {
			type: 'APP_EVENT',
			appEvent: {
				type: 'QUEUE_UPDATED',
				id: 'app-q',
				time: 100,
				actor: { type: 'ingame-user', playerId: 'eos-1' },
				serverId: 's1',
				matchId: 1,
				causeId: null,
				instanceId: null,
				trigger: 'external-layer-change',
				ops: [],
				prevList: [],
				list: [],
			} satisfies AppEvents.QueueUpdated,
		}
		CHAT.handleEvent(state, appEvent)
		const entry = state.eventBuffer[0]
		if (entry.type !== 'APP_EVENT') throw new Error('expected APP_EVENT')
		expect(entry.actorPlayer?.ids.eos).toBe('eos-1')
	})
})

describe('warn target summary grouping', () => {
	function summaryFor(players: SM.Player[], squads: SM.UniqueSquad[], targets: SM.PlayerId[]): CHAT.WarnSummary {
		const state = CHAT.getInitialChatState()
		state.interpolatedState.players = players
		state.interpolatedState.squads = squads
		CHAT.handleEvent(state, warnAppEvent(targets))
		const entry = state.eventBuffer[0]
		if (entry.type !== 'APP_EVENT') throw new Error('expected APP_EVENT')
		return entry.warnSummary
	}

	it('everyone: all players warned', () => {
		const players = [makePlayer('a'), makePlayer('b')]
		expect(summaryFor(players, [], ['a', 'b'])).toEqual({ type: 'everyone' })
	})

	it('all-admins: exactly the admin set warned', () => {
		const players = [makePlayer('a', { isAdmin: true }), makePlayer('b', { isAdmin: true }), makePlayer('c')]
		expect(summaryFor(players, [], ['a', 'b'])).toEqual({ type: 'all-admins' })
	})

	it('teams: an entire team warned', () => {
		const players = [
			makePlayer('a', { teamId: 1 }),
			makePlayer('b', { teamId: 1 }),
			makePlayer('c', { teamId: 2 }),
			makePlayer('d', { teamId: 2 }),
		]
		expect(summaryFor(players, [], ['a', 'b'])).toEqual({ type: 'teams', teamIds: [1] })
	})

	it('squads: a full squad plus loose players (not a full team)', () => {
		const players = [
			makePlayer('a', { teamId: 1, squadId: 1 }),
			makePlayer('b', { teamId: 1, squadId: 1 }),
			makePlayer('c', { teamId: 1 }), // loose, warned
			makePlayer('e', { teamId: 1 }), // loose, NOT warned -> team 1 isn't fully warned
			makePlayer('d', { teamId: 2 }),
		]
		const squads = [makeSquad(1, 1, 'a', 101)]
		const summary = summaryFor(players, squads, ['a', 'b', 'c'])
		expect(summary.type).toBe('squads')
		if (summary.type !== 'squads') throw new Error('unreachable')
		expect(summary.squads.map(s => s.uniqueId)).toEqual([101])
		expect(summary.otherPlayerCount).toBe(1)
	})

	it('players: an ad-hoc subset with no full group', () => {
		const players = [makePlayer('a', { teamId: 1, squadId: 1 }), makePlayer('b', { teamId: 1, squadId: 1 }), makePlayer('c', { teamId: 1 })]
		const squads = [makeSquad(1, 1, 'a', 101)]
		expect(summaryFor(players, squads, ['a', 'c'])).toEqual({ type: 'players' })
	})
})
