// @vitest-environment happy-dom
import type { EmuEvent } from '@/models/sandbox.models'
import { describe, expect, it } from 'vitest'
import * as SandboxFrame from './sandbox.frame'

// consoleView is pure, so it is exercised directly against a store shape rather than through a live frame.

function store(events: EmuEvent[], over: Partial<SandboxFrame.Store> = {}): SandboxFrame.Store {
	return {
		serverId: 'sandbox',
		state: null,
		unavailable: false,
		events,
		channel: 'unified',
		hideNoise: true,
		playerSearch: '',
		playerPage: 0,
		speaker: null,
		chatChannel: 'ChatAll',
		...over,
	}
}

const recv = (body: string): EmuEvent => ({ type: 'rcon', dir: 'recv', body, time: 0 })
const send = (body: string): EmuEvent => ({ type: 'rcon', dir: 'send', body, time: 0 })
const log = (line: string): EmuEvent => ({ type: 'log', line, time: 0 })

describe('consoleView', () => {
	it('drops a poll whose answer has not changed, request included', () => {
		const view = SandboxFrame.Sel.consoleView(store([
			recv('ListPlayers'),
			send('a'),
			recv('ListPlayers'),
			send('a'),
		]))
		expect(view.events).toEqual([recv('ListPlayers'), send('a')])
		expect(view.hidden).toBe(2)
	})

	it('keeps the poll that finally reports something different', () => {
		const view = SandboxFrame.Sel.consoleView(store([
			recv('ListPlayers'),
			send('a'),
			recv('ListPlayers'),
			send('a'),
			recv('ListPlayers'),
			send('b'),
		]))
		expect(view.events.map((e) => e.type === 'rcon' && e.body)).toEqual(['ListPlayers', 'a', 'ListPlayers', 'b'])
	})

	// two commands polled on the same timer interleave, so a repeat is per-command rather than against the last response seen
	it('compares a response against the last one for its own command', () => {
		const view = SandboxFrame.Sel.consoleView(store([
			recv('ListPlayers'),
			send('players'),
			recv('ListSquads'),
			send('squads'),
			recv('ListPlayers'),
			send('players'),
		]))
		expect(view.events).toEqual([recv('ListPlayers'), send('players'), recv('ListSquads'), send('squads')])
	})

	it('never hides a chat packet, which the server pushes without being asked', () => {
		const chat = send('[ChatAll] Alice: hi')
		const view = SandboxFrame.Sel.consoleView(store([chat, chat]))
		expect(view.events).toEqual([chat, chat])
	})

	it('hides the tick rate heartbeat but not the rest of the log', () => {
		const view = SandboxFrame.Sel.consoleView(store([
			log('LogSquad: USQGameState: Server Tick Rate: 60.00'),
			log('LogSquad: Warning: something happened'),
		]))
		expect(view.events).toEqual([log('LogSquad: Warning: something happened')])
		expect(view.hidden).toBe(1)
	})

	it('shows everything, and nothing hidden, once the filter is off', () => {
		const events = [recv('ListPlayers'), send('a'), recv('ListPlayers'), send('a')]
		const view = SandboxFrame.Sel.consoleView(store(events, { hideNoise: false }))
		expect(view.events).toEqual(events)
		expect(view.hidden).toBe(0)
	})

	it('filters to one channel before hiding noise, so a tab counts only its own', () => {
		const view = SandboxFrame.Sel.consoleView(store(
			[recv('ListPlayers'), send('a'), log('LogSquad: USQGameState: Server Tick Rate: 60.00')],
			{ channel: 'rcon' },
		))
		expect(view.events).toEqual([recv('ListPlayers'), send('a')])
		expect(view.hidden).toBe(0)
	})
})
