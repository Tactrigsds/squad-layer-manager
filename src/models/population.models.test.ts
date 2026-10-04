import { describe, expect, it } from 'vitest'

import * as CHAT from '@/models/chat.models'
import * as Activity from '@/models/player-activity.models'
import * as Pop from '@/models/population.models'
import type * as SM from '@/models/squad.models'

const S = Pop.SAMPLE_STEP_MS
const m = (minutes: number) => minutes * 60_000
const TEN = Pop.idleStepIndex(10)

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

function makeSquad(squadId: number, teamId: SM.TeamId): SM.UniqueSquad {
	return { squadId, teamId, creator: 'x', uniqueId: squadId * 10 + teamId, squadName: `Squad ${squadId}`, locked: false }
}

let nextId = 1
const base = (time: number, matchId = 1) => ({ id: nextId++, time, matchId })

const reset = (time: number, players: SM.Player[]): CHAT.EventEnriched => ({
	type: 'RESET',
	source: 'server-roll',
	state: { players, squads: [] },
	...base(time),
})
const connected = (time: number, player: SM.Player): CHAT.EventEnriched => ({ type: 'PLAYER_CONNECTED', player, ...base(time) })
const disconnected = (time: number, player: SM.Player): CHAT.EventEnriched => ({ type: 'PLAYER_DISCONNECTED', player, ...base(time) })
const changedTeam = (time: number, player: SM.Player, to: SM.TeamId): CHAT.EventEnriched => ({
	type: 'PLAYER_CHANGED_TEAM',
	player,
	newTeamId: to,
	prevTeamId: player.teamId,
	...base(time),
})
const chat = (time: number, player: SM.Player): CHAT.EventEnriched => ({
	type: 'CHAT_MESSAGE',
	player,
	message: 'hi',
	channel: { type: 'ChatAll' },
	...base(time),
})
const joinedSquad = (time: number, player: SM.Player, squad: SM.UniqueSquad): CHAT.EventEnriched => ({
	type: 'PLAYER_JOINED_SQUAD',
	player,
	uniqueId: squad.uniqueId,
	squad,
	...base(time),
})
const disbanded = (time: number, squad: SM.UniqueSquad): CHAT.EventEnriched => ({
	type: 'SQUAD_DISBANDED',
	uniqueId: squad.uniqueId,
	squad,
	...base(time),
})
const detailsChanged = (time: number, player: SM.Player, details: Partial<SM.Player>): CHAT.EventEnriched => {
	const next = { ...player, ...details }
	return {
		type: 'PLAYER_DETAILS_CHANGED',
		player: next,
		details: { role: next.role, isAdmin: next.isAdmin, partyId: next.partyId, vehicle: next.vehicle },
		...base(time),
	}
}
const polled = (time: number): CHAT.EventEnriched => ({ type: 'TEAMS_POLLED_UPDATE', ...base(time) })
const rconDisconnected = (time: number): CHAT.EventEnriched => ({ type: 'RCON_DISCONNECTED', ...base(time) }) as CHAT.EventEnriched
const appEvent = (time: number, collapsed: CHAT.EventEnriched[]): CHAT.EventEnriched =>
	({ type: 'APP_EVENT', id: `app-${nextId++}`, time, matchId: 1, collapsed }) as unknown as CHAT.EventEnriched

// the value of `row` at time t, read off a single run
function at(samples: Pop.Samples, row: (run: Pop.Run) => number[], t: number): number | undefined {
	for (const run of samples) {
		const i = (t - run.start) / S
		if (i >= 0 && i < run.total.length) return row(run)[i]
	}
	return undefined
}
const total = (samples: Pop.Samples, t: number) => at(samples, (run) => run.total, t)
const idle = (samples: Pop.Samples, t: number, k = TEN) => at(samples, (run) => run.idle[k], t)

describe('population sampler', () => {
	it('samples the roster on the grid, from the first roster it sees', () => {
		const a = makePlayer('a', { teamId: 1 })
		const b = makePlayer('b', { teamId: 2 })
		const c = makePlayer('c', { teamId: null })
		const samples = Pop.sampleMatch([reset(10_000, [a, b, c]), connected(S + 5_000, makePlayer('d', { teamId: 2 })), polled(3 * S)])

		expect(samples).toHaveLength(1)
		expect(samples[0].start).toBe(S)
		// the sample at S comes before the connect at S + 5s
		expect(samples[0].total).toEqual([3, 4, 4])
		expect(samples[0].team1).toEqual([1, 1, 1])
		expect(samples[0].team2).toEqual([1, 2, 2])
	})

	it('counts a player idle once the threshold passes without activity, and active again after any', () => {
		const a = makePlayer('a')
		const samples = Pop.sampleMatch([reset(0, [a]), chat(m(12), a), polled(m(30))])

		expect(idle(samples, m(9.5))).toBe(0)
		expect(idle(samples, m(10))).toBe(1)
		expect(idle(samples, m(12) + S)).toBe(0)
		expect(idle(samples, m(22))).toBe(1)
		// the 5 minute step counts a subset of no one: it reads idle from five minutes after the chat
		expect(idle(samples, m(17), Pop.idleStepIndex(5))).toBe(1)
		expect(idle(samples, m(17), Pop.idleStepIndex(15))).toBe(0)
	})

	it('never counts a player in a squad or in a vehicle as idle', () => {
		const squad = makeSquad(1, 1)
		const a = makePlayer('a')
		const b = makePlayer('b')
		const c = makePlayer('c', { squadId: 1 })
		const samples = Pop.sampleMatch([
			reset(0, [a, b, c]),
			joinedSquad(m(1), a, squad),
			detailsChanged(m(1), b, { vehicle: 'minsk400 (Driver)' }),
			polled(m(20)),
			disbanded(m(20), { ...squad, squadId: 1 }),
			polled(m(40)),
		])

		expect(idle(samples, m(19))).toBe(0)
		// the disband takes a and c out of their squad, and both last acted over ten minutes ago; b is still driving
		expect(idle(samples, m(21))).toBe(2)
	})

	it('takes a player out of their squad when they change team', () => {
		const a = makePlayer('a', { squadId: 1 })
		const samples = Pop.sampleMatch([reset(0, [a]), changedTeam(m(1), a, 2), polled(m(15))])
		expect(idle(samples, m(12))).toBe(1)
		expect(at(samples, (run) => run.team2, m(12))).toBe(1)
	})

	it('stops sampling while RCON is down, and resumes on the roster the reconnect restates', () => {
		const a = makePlayer('a')
		const samples = Pop.sampleMatch([reset(0, [a]), rconDisconnected(m(1)), reset(m(5), [a, makePlayer('b')]), polled(m(6))])
		expect(samples).toHaveLength(2)
		expect(total(samples, m(3))).toBeUndefined()
		expect(total(samples, m(5.5))).toBe(2)
	})

	it('replays events collapsed under an app event in the order they happened', () => {
		const a = makePlayer('a', { teamId: 1 })
		const samples = Pop.sampleMatch([reset(0, [a]), appEvent(10, [changedTeam(S + 1, a, 2)]), disconnected(3 * S + 1, a)])
		// the last sample is the roster after the disconnect, which closes the match
		expect(samples[0].team1).toEqual([1, 1, 0, 0, 0])
		expect(samples[0].team2).toEqual([0, 0, 1, 1, 0])
		expect(samples[0].total).toEqual([1, 1, 1, 1, 0])
	})

	it('tracks the live buffer incrementally to the same samples as a full replay, plus a provisional one', () => {
		const a = makePlayer('a')
		const b = makePlayer('b', { teamId: 2 })
		const events = [reset(0, [a]), connected(m(1), b), chat(m(2), a), changedTeam(m(3), a, 2), disconnected(m(14), b), polled(m(20))]
		const state = CHAT.getInitialChatState()
		for (const event of events) {
			state.eventBuffer.push(event)
			Pop.live(state, 1)
		}
		expect(Pop.live(state, 1)).toEqual(Pop.sampleMatch(events))
	})

	it('shows a change before the next grid time passes, and keeps its result while nothing changes', () => {
		const state = CHAT.getInitialChatState()
		state.eventBuffer.push(reset(0, [makePlayer('a')]))
		const first = Pop.live(state, 1)
		expect(first[0].total).toEqual([1])
		state.eventBuffer.push(connected(5_000, makePlayer('b')))
		const joined = Pop.live(state, 1)
		expect(joined[0].total).toEqual([1, 2])
		state.eventBuffer.push(polled(6_000))
		expect(Pop.live(state, 1)).toBe(joined)
	})

	it("ignores another match's entries", () => {
		const state = CHAT.getInitialChatState()
		state.eventBuffer.push(reset(0, [makePlayer('a')]), { ...connected(5, makePlayer('b')), matchId: 2 }, polled(S + 1))
		expect(Pop.live(state, 1)[0].total).toEqual([1, 1, 1])
	})
})

describe('population buckets', () => {
	it('sums samples per bucket, keeps their extremes, and normalizes teams by match parity', () => {
		const run: Pop.Run = {
			start: 0,
			team1: [3, 5, 7],
			team2: [1, 1, 1],
			total: [4, 6, 8],
			idle: Activity.IDLE_STEPS_MIN.map(() => [0, 1, 2]),
			joins: [0, 2, 2],
			leaves: [0, 0, 1],
		}
		const buckets = Pop.emptyBuckets(0, 3 * S, 2 * S)
		Pop.addToBuckets(buckets, [run], 1, 6)

		expect(buckets.n).toEqual([2, 1])
		expect(buckets.total).toEqual([10, 8])
		// odd parity: team 2 is Team A
		expect(buckets.teamA).toEqual([2, 1])
		expect(buckets.teamB).toEqual([8, 7])
		expect(buckets.idle[TEN]).toEqual([1, 2])
		expect(buckets.max).toEqual([6, 8])
		expect(buckets.min).toEqual([4, 8])
		expect(buckets.gapMax).toEqual([4, 6])
		// a cap of 6 is reached by the second and third samples
		expect(buckets.full).toEqual([1, 1])
		expect(buckets.joins).toEqual([2, 2])
		expect(buckets.leaves).toEqual([0, 1])
	})

	it('merges two sources over the same grid', () => {
		const one = (start: number, total: number, idle: number): Pop.Run => ({
			start,
			team1: [total],
			team2: [0],
			total: [total],
			idle: Activity.IDLE_STEPS_MIN.map(() => [idle]),
			joins: [0],
			leaves: [0],
		})
		const a = Pop.emptyBuckets(0, 2 * S, S)
		const b = Pop.emptyBuckets(0, 2 * S, S)
		Pop.addToBuckets(a, [one(0, 1, 0)], 0, 100)
		Pop.addToBuckets(b, [one(S, 2, 1)], 0, 100)
		const merged = Pop.mergeBuckets(a, b)
		expect(merged.n).toEqual([1, 1])
		expect(merged.total).toEqual([1, 2])
		expect(merged.idle[0]).toEqual([0, 1])
		expect(merged.max).toEqual([1, 2])
		expect(merged.min).toEqual([1, 2])
	})
})

describe('population churn', () => {
	it('counts connects and disconnects into the sample after them, but not a restated roster', () => {
		const a = makePlayer('a')
		const b = makePlayer('b')
		const samples = Pop.sampleMatch([
			reset(0, [a]),
			connected(5_000, b),
			disconnected(10_000, a),
			reset(S + 1, [b, makePlayer('c')]),
			polled(2 * S + 1),
		])
		expect(samples[0].joins).toEqual([0, 1, 0, 0])
		expect(samples[0].leaves).toEqual([0, 1, 0, 0])
	})
})
