// @vitest-environment happy-dom
import type { ConsoleEvent } from '@/models/server-console.models'
import { describe, expect, it } from 'vitest'
import * as ConsoleFrame from './server-console.frame'

// Sel.view is pure, so it is exercised directly against a store shape rather than through a live frame.

function store(events: ConsoleEvent[], over: Partial<ConsoleFrame.Store> = {}): ConsoleFrame.Store {
	return {
		serverId: 'server-1',
		events,
		tab: 'unified',
		hideNoise: true,
		denied: false,
		...over,
	}
}

// seq only exists to key the rendered list; the filter never reads it, so it stays constant here to keep
// expectations comparable by content
const recv = (body: string, reqId = 1): ConsoleEvent => ({ type: 'rcon', dir: 'recv', body, time: 0, seq: 0, reqId })
const send = (body: string, reqId = 1): ConsoleEvent => ({ type: 'rcon', dir: 'send', body, time: 0, seq: 0, reqId })
const log = (line: string): ConsoleEvent => ({ type: 'log', line, time: 0, seq: 0 })

describe('Sel.view', () => {
	it('drops a poll whose answer has not changed, request included', () => {
		const view = ConsoleFrame.Sel.view(store([recv('ListPlayers'), send('a'), recv('ListPlayers'), send('a')]))
		expect(view.events).toEqual([recv('ListPlayers'), send('a')])
		expect(view.hidden).toBe(2)
	})

	it('keeps the poll that finally reports something different', () => {
		const view = ConsoleFrame.Sel.view(
			store([recv('ListPlayers'), send('a'), recv('ListPlayers'), send('a'), recv('ListPlayers'), send('b')]),
		)
		expect(view.events.map((e) => e.type === 'rcon' && e.body)).toEqual(['ListPlayers', 'a', 'ListPlayers', 'b'])
	})

	// two commands polled on the same timer interleave, so a repeat is per-command rather than against the last response seen
	it('compares a response against the last one for its own command', () => {
		const view = ConsoleFrame.Sel.view(
			store([
				recv('ListPlayers', 1),
				send('players', 1),
				recv('ListSquads', 2),
				send('squads', 2),
				recv('ListPlayers', 3),
				send('players', 3),
			]),
		)
		expect(view.events).toEqual([recv('ListPlayers', 1), send('players', 1), recv('ListSquads', 2), send('squads', 2)])
	})

	// SLM has several commands in flight at once and the server answers them in whatever order it finishes. Pairing
	// by position rather than by request id attributed each response to the wrong command.
	it('pairs a response with its own command when the answers come back out of order', () => {
		const view = ConsoleFrame.Sel.view(
			store([
				recv('ListPlayers', 1),
				recv('ListSquads', 2),
				send('squads', 2),
				send('players', 1),
				recv('ListPlayers', 3),
				recv('ListSquads', 4),
				send('squads', 4),
				send('players', 3),
			]),
		)
		expect(view.events).toEqual([recv('ListPlayers', 1), recv('ListSquads', 2), send('squads', 2), send('players', 1)])
	})

	it('never hides a chat packet, which the server pushes without being asked', () => {
		const chat: ConsoleEvent = { type: 'rcon', dir: 'send', body: '[ChatAll] Alice: hi', time: 0, seq: 0 }
		const view = ConsoleFrame.Sel.view(store([chat, chat]))
		expect(view.events).toEqual([chat, chat])
	})

	it('hides the tick rate heartbeat but not the rest of the log', () => {
		const view = ConsoleFrame.Sel.view(
			store([log('LogSquad: USQGameState: Server Tick Rate: 60.00'), log('LogSquad: Warning: something happened')]),
		)
		expect(view.events).toEqual([log('LogSquad: Warning: something happened')])
		expect(view.hidden).toBe(1)
	})

	it('shows everything, and nothing hidden, once the filter is off', () => {
		const events = [recv('ListPlayers'), send('a'), recv('ListPlayers'), send('a')]
		const view = ConsoleFrame.Sel.view(store(events, { hideNoise: false }))
		expect(view.events).toEqual(events)
		expect(view.hidden).toBe(0)
	})

	it('filters to one channel before hiding noise, so a tab counts only its own', () => {
		const view = ConsoleFrame.Sel.view(
			store([recv('ListPlayers'), send('a'), log('LogSquad: USQGameState: Server Tick Rate: 60.00')], { tab: 'rcon' }),
		)
		expect(view.events).toEqual([recv('ListPlayers'), send('a')])
		expect(view.hidden).toBe(0)
	})
})
