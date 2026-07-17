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
		adminGroups: [],
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

	// a queue save renders the next layer itself, so its MAP_SET server event must fold into the QUEUE_UPDATED rather
	// than trailing it as a redundant "Next layer set to X" line
	it('collapses a queue-driven MAP_SET into its QUEUE_UPDATED entry', () => {
		const state = seededState([makePlayer('eos-1')])
		const queueUpdated: CHAT.AppFeedEvent = {
			type: 'APP_EVENT',
			appEvent: {
				type: 'QUEUE_UPDATED',
				id: 'app-q',
				time: 100,
				actor: { type: 'slm-user', userId: 1n },
				serverId: 's1',
				matchId: 1,
				causeId: null,
				instanceId: null,
				trigger: 'user-edit',
				ops: [],
				prevList: [],
				list: [],
			} satisfies AppEvents.QueueUpdated,
		}
		CHAT.handleEvent(state, queueUpdated)
		const mapSet: SE.MapSet = {
			type: 'MAP_SET',
			id: 1,
			time: 101,
			matchId: 1,
			layerId: 'l1',
			source: { type: 'event', id: 'app-q' },
		}
		CHAT.handleEvent(state, mapSet)

		expect(state.eventBuffer).toHaveLength(1)
		const entry = state.eventBuffer[0]
		if (entry.type !== 'APP_EVENT') throw new Error('expected APP_EVENT')
		expect(entry.collapsed).toHaveLength(1)
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

describe('standalone warn burst aggregation', () => {
	function seededState(players: SM.Player[]): CHAT.ChatState {
		const state = CHAT.getInitialChatState()
		state.interpolatedState.players = players
		return state
	}
	const rcon = { type: 'rcon' } as const
	const admin = (eos: string): SE.PlayerWarned['source'] => ({ type: 'player', playerIds: { eos, username: eos, steam: eos } })

	it('merges same-text same-source warns within the window into one WARNS_AGGREGATED entry', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2')])
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, rcon))
		CHAT.handleEvent(state, warnServerEvent('eos-2', 'stop', 2, rcon))

		expect(state.eventBuffer).toHaveLength(1)
		const entry = state.eventBuffer[0]
		if (entry.type !== 'WARNS_AGGREGATED') throw new Error('expected WARNS_AGGREGATED')
		expect(entry.warns.map(w => w.player.ids.eos)).toEqual(['eos-1', 'eos-2'])
		// tracks the latest absorbed warn's id; time anchored to the first
		expect(entry.id).toBe(2)
		expect(entry.time).toBe(101)
	})

	it('appends a third matching warn to the existing group', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2'), makePlayer('eos-3')])
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, rcon))
		CHAT.handleEvent(state, warnServerEvent('eos-2', 'stop', 2, rcon))
		CHAT.handleEvent(state, warnServerEvent('eos-3', 'stop', 3, rcon))

		expect(state.eventBuffer).toHaveLength(1)
		const entry = state.eventBuffer[0]
		if (entry.type !== 'WARNS_AGGREGATED') throw new Error('expected WARNS_AGGREGATED')
		expect(entry.warns).toHaveLength(3)
		expect(entry.id).toBe(3)
	})

	it('keeps warns with different text separate', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2')])
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, rcon))
		CHAT.handleEvent(state, warnServerEvent('eos-2', 'go', 2, rcon))

		expect(state.eventBuffer.map(e => e.type)).toEqual(['PLAYER_WARNED', 'PLAYER_WARNED'])
	})

	it('keeps same-text warns from different sources separate', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2')])
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, admin('adminA')))
		CHAT.handleEvent(state, warnServerEvent('eos-2', 'stop', 2, admin('adminB')))

		expect(state.eventBuffer.map(e => e.type)).toEqual(['PLAYER_WARNED', 'PLAYER_WARNED'])
	})

	it('does not merge warns further apart than the aggregation window', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2')])
		const first: SE.PlayerWarned = { type: 'PLAYER_WARNED', id: 1, time: 1000, matchId: 1, reason: 'stop', player: 'eos-1', source: rcon }
		const late: SE.PlayerWarned = {
			type: 'PLAYER_WARNED',
			id: 2,
			time: 1000 + 6000,
			matchId: 1,
			reason: 'stop',
			player: 'eos-2',
			source: rcon,
		}
		CHAT.handleEvent(state, first)
		CHAT.handleEvent(state, late)

		expect(state.eventBuffer.map(e => e.type)).toEqual(['PLAYER_WARNED', 'PLAYER_WARNED'])
	})

	it('merges across an interleaving non-warn event within the window', () => {
		const state = seededState([makePlayer('eos-1'), makePlayer('eos-2')])
		CHAT.handleEvent(state, warnServerEvent('eos-1', 'stop', 1, rcon))
		const chat: SE.ChatMessage = {
			type: 'CHAT_MESSAGE',
			id: 2,
			time: 102,
			matchId: 1,
			player: 'eos-1',
			message: 'hi',
			channel: { type: 'ChatAll' },
		}
		CHAT.handleEvent(state, chat)
		CHAT.handleEvent(state, warnServerEvent('eos-2', 'stop', 3, rcon))

		expect(state.eventBuffer.map(e => e.type)).toEqual(['WARNS_AGGREGATED', 'CHAT_MESSAGE'])
		const entry = state.eventBuffer[0]
		if (entry.type !== 'WARNS_AGGREGATED') throw new Error('expected WARNS_AGGREGATED')
		expect(entry.warns).toHaveLength(2)
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

describe('chat.models recent players', () => {
	function connected(player: SM.Player, id: number): SE.PlayerConnected {
		return { type: 'PLAYER_CONNECTED', id, time: 100 + id, matchId: 1, player }
	}
	function disconnected(eos: SM.PlayerId, id: number): SE.PlayerDisconnected {
		return { type: 'PLAYER_DISCONNECTED', id, time: 100 + id, matchId: 1, player: eos }
	}
	function died(victim: SM.PlayerId, attacker: SM.PlayerId, id: number): SE.PlayerDied {
		return { type: 'PLAYER_DIED', id, time: 100 + id, matchId: 1, victim, attacker, damage: 100, weapon: 'rifle', variant: 'normal' }
	}
	function reset(players: SM.Player[], id: number, source: SE.Reset['source']): SE.Reset {
		return { type: 'RESET', id, time: 100 + id, matchId: 1, source, state: { players, squads: [] } }
	}
	function newGame(id: number): SE.NewGame {
		return { type: 'NEW_GAME', id, time: 100 + id, matchId: 1, source: 'new-game-detected', layerId: 'l1' }
	}
	const recentIds = (state: CHAT.ChatState) => state.interpolatedState.recentPlayers.map(p => p.ids.eos)

	it('keeps a disconnected player in recentPlayers, but off the live roster', () => {
		const state = CHAT.getInitialChatState()
		CHAT.handleEvent(state, connected(makePlayer('a'), 1))
		CHAT.handleEvent(state, connected(makePlayer('b'), 2))
		CHAT.handleEvent(state, disconnected('a', 3))

		expect(state.interpolatedState.players.map(p => p.ids.eos)).toEqual(['b'])
		expect(recentIds(state)).toEqual(['a', 'b'])
	})

	it('does not duplicate a player who reconnects', () => {
		const state = CHAT.getInitialChatState()
		CHAT.handleEvent(state, connected(makePlayer('a'), 1))
		CHAT.handleEvent(state, disconnected('a', 2))
		CHAT.handleEvent(state, connected(makePlayer('a'), 3))

		expect(recentIds(state)).toEqual(['a'])
	})

	it('keeps a score across a disconnect and reconnect', () => {
		const state = CHAT.getInitialChatState()
		CHAT.handleEvent(state, connected(makePlayer('a'), 1))
		CHAT.handleEvent(state, connected(makePlayer('b'), 2))
		CHAT.handleEvent(state, died('b', 'a', 3))
		CHAT.handleEvent(state, disconnected('a', 4))

		expect(state.interpolatedState.playerStats['a'].kills).toBe(1)
		expect(recentIds(state)).toContain('a')

		CHAT.handleEvent(state, connected(makePlayer('a'), 5))
		expect(state.interpolatedState.playerStats['a'].kills).toBe(1)
	})

	// a same-match rcon reconnect reseeds the roster with a RESET. Wiping stats there would cost the match every
	// score built up before the reconnect.
	it('keeps scores across a same-match rcon reconnect', () => {
		const state = CHAT.getInitialChatState()
		CHAT.handleEvent(state, connected(makePlayer('a'), 1))
		CHAT.handleEvent(state, connected(makePlayer('b'), 2))
		CHAT.handleEvent(state, died('b', 'a', 3))

		CHAT.handleEvent(state, reset([makePlayer('a'), makePlayer('b'), makePlayer('c')], 4, 'rcon-reconnected'))

		expect(state.interpolatedState.playerStats['a'].kills).toBe(1)
		expect(recentIds(state)).toEqual(['a', 'b', 'c'])
	})

	it('clears recentPlayers and scores at a match boundary', () => {
		const state = CHAT.getInitialChatState()
		CHAT.handleEvent(state, connected(makePlayer('a'), 1))
		CHAT.handleEvent(state, connected(makePlayer('b'), 2))
		CHAT.handleEvent(state, died('b', 'a', 3))
		CHAT.handleEvent(state, disconnected('b', 4))

		CHAT.handleEvent(state, newGame(5))

		expect(state.interpolatedState.playerStats).toEqual({})
		// 'b' left before the boundary, so only the surviving roster carries over
		expect(recentIds(state)).toEqual(['a'])
	})
})

describe('chat.models recent squads', () => {
	function connected(player: SM.Player, id: number): SE.PlayerConnected {
		return { type: 'PLAYER_CONNECTED', id, time: 100 + id, matchId: 1, player }
	}
	function squadCreated(squad: SM.UniqueSquad, id: number): SE.SquadCreated {
		return { type: 'SQUAD_CREATED', id, time: 100 + id, matchId: 1, squad }
	}
	function squadDisbanded(uniqueId: number, id: number): SE.SquadDisbanded {
		return { type: 'SQUAD_DISBANDED', id, time: 100 + id, matchId: 1, uniqueId }
	}
	function squadRenamed(uniqueId: number, oldSquadName: string, newSquadName: string, id: number): SE.SquadRenamed {
		return { type: 'SQUAD_RENAMED', id, time: 100 + id, matchId: 1, uniqueId, oldSquadName, newSquadName }
	}
	function newGame(id: number): SE.NewGame {
		return { type: 'NEW_GAME', id, time: 100 + id, matchId: 1, source: 'new-game-detected', layerId: 'l1' }
	}
	const recentUniqueIds = (state: CHAT.ChatState) => state.interpolatedState.recentSquads.map(s => s.uniqueId)

	function stateWithSquad() {
		const state = CHAT.getInitialChatState()
		CHAT.handleEvent(state, connected(makePlayer('a'), 1))
		CHAT.handleEvent(state, squadCreated(makeSquad(1, 1, 'a', 101), 2))
		return state
	}

	it('keeps a disbanded squad in recentSquads, but off the live squad list', () => {
		const state = stateWithSquad()
		CHAT.handleEvent(state, squadDisbanded(101, 3))

		expect(state.interpolatedState.squads).toHaveLength(0)
		expect(recentUniqueIds(state)).toEqual([101])
		const recent = CHAT.InterpolableState.findRecentSquad(state.interpolatedState, 101)
		expect(recent).toMatchObject({ uniqueId: 101, squadId: 1, teamId: 1, creator: 'a', squadName: 'Squad 1' })
	})

	it('tracks a rename, and keeps the new name after the squad disbands', () => {
		const state = stateWithSquad()
		CHAT.handleEvent(state, squadRenamed(101, 'Squad 1', 'Armour', 3))
		expect(recentUniqueIds(state)).toEqual([101])
		expect(CHAT.InterpolableState.findRecentSquad(state.interpolatedState, 101)?.squadName).toBe('Armour')

		CHAT.handleEvent(state, squadDisbanded(101, 4))
		expect(CHAT.InterpolableState.findRecentSquad(state.interpolatedState, 101)?.squadName).toBe('Armour')
	})

	// squad ids get reused, so a later instance must not inherit the earlier one's entry
	it('tracks two instances that reuse the same in-game squad id separately', () => {
		const state = stateWithSquad()
		CHAT.handleEvent(state, squadDisbanded(101, 3))
		CHAT.handleEvent(state, squadCreated(makeSquad(1, 1, 'a', 102), 4))

		expect(recentUniqueIds(state)).toEqual([101, 102])
	})

	it('clears recentSquads at a match boundary', () => {
		const state = stateWithSquad()
		CHAT.handleEvent(state, squadDisbanded(101, 3))
		CHAT.handleEvent(state, newGame(4))

		expect(recentUniqueIds(state)).toEqual([])
	})
})

describe('admin camera tracking', () => {
	function seededState(players: SM.Player[]): CHAT.ChatState {
		const state = CHAT.getInitialChatState()
		state.interpolatedState.players = players
		return state
	}

	function possessed(player: SM.PlayerId, id: number): SE.PossessedAdminCamera {
		return { type: 'POSSESSED_ADMIN_CAMERA', id, time: id, matchId: 1, player }
	}
	function unpossessed(player: SM.PlayerId, id: number): SE.UnpossessedAdminCamera {
		return { type: 'UNPOSSESSED_ADMIN_CAMERA', id, time: id, matchId: 1, player }
	}

	it('tracks possess and unpossess', () => {
		const state = seededState([makePlayer('a'), makePlayer('b')])
		CHAT.handleEvent(state, possessed('a', 1))
		CHAT.handleEvent(state, possessed('b', 2))
		expect(state.interpolatedState.adminCamPlayerIds).toEqual(['a', 'b'])

		CHAT.handleEvent(state, unpossessed('a', 3))
		expect(state.interpolatedState.adminCamPlayerIds).toEqual(['b'])
	})

	it('drops a player who disconnects while in admin camera', () => {
		const state = seededState([makePlayer('a')])
		CHAT.handleEvent(state, possessed('a', 1))
		CHAT.handleEvent(state, { type: 'PLAYER_DISCONNECTED', id: 2, time: 2, matchId: 1, player: 'a' })
		expect(state.interpolatedState.adminCamPlayerIds).toEqual([])
	})

	it('assumes nobody is in admin camera after a RESET', () => {
		const state = seededState([makePlayer('a')])
		CHAT.handleEvent(state, possessed('a', 1))
		CHAT.handleEvent(state, {
			type: 'RESET',
			id: 2,
			time: 2,
			matchId: 1,
			source: 'rcon-reconnected',
			state: { players: [makePlayer('a')], squads: [] },
		})
		expect(state.interpolatedState.adminCamPlayerIds).toEqual([])
	})
})
