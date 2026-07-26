import type * as FRM from '@/lib/frame'
import * as Zus from '@/lib/zustand'
import type { ConsoleEvent } from '@/models/server-console.models'
import * as SC from '@/models/server-console.models'
import * as RPC from '@/orpc.client'

import { frameManager } from './frame-manager'

// The console's state, keyed by server so every view of one server's tail reads the same buffer: the window, a
// pop-out of it, and the panel embedded in the sandbox controls.

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>
export type Input = { serverId: string }
export type Types = {
	name: 'serverConsole'
	key: FRM.RawInstanceKey<{ serverId: string }>
	input: Input
	state: Store
}

export type Tab = 'unified' | SC.ConsoleChannel
export const TABS: Tab[] = ['unified', 'rcon', 'log', 'command']

export type Store = {
	serverId: string
	events: ConsoleEvent[]
	tab: Tab
	hideNoise: boolean
	denied: boolean
}

function createKey(frameId: symbol, input: Input): Types['key'] {
	return { frameId, serverId: input.serverId }
}

function setup(args: FRM.SetupArgs<Input, Store>) {
	const { serverId } = args.input
	args.set({ serverId, events: [], tab: 'unified', hideNoise: true, denied: false } satisfies Store)

	args.cleanup.push(
		RPC.observe(`serverConsole.watch:${serverId}`, () => RPC.orpc.serverConsole.watch.call({ serverId })).subscribe((res) => {
			if (res.code !== 'ok') {
				args.set({ denied: true })
				return
			}
			const next = args.get().events.concat(res.events)
			args.set({
				denied: false,
				events: next.length > SC.BUFFER_SIZE ? next.slice(next.length - SC.BUFFER_SIZE) : next,
			})
		}),
	)
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'serverConsole',
	createKey,
	setup,
})

// SLM polls the same handful of rcon commands on a timer and the game reports its tick rate on another, so most of
// what a quiet server produces says only that nothing has changed. Dropping it is what makes the console readable
// at a glance; the checkbox is there because "nothing changed" is occasionally the thing being diagnosed.
function denoise(events: readonly ConsoleEvent[]): ConsoleEvent[] {
	const keep = new Array<boolean>(events.length).fill(true)
	const lastResponse = new Map<string, string>()
	type Request = { command: string; index: number }
	const outstanding = new Map<number, Request>()
	for (let i = 0; i < events.length; i++) {
		const event = events[i]
		if (event.type === 'log') {
			if (SC.TICK_RATE_LINE.test(event.line)) keep[i] = false
			continue
		}
		if (event.type !== 'rcon') continue
		if (event.dir === 'recv') {
			if (event.reqId !== undefined) outstanding.set(event.reqId, { command: event.body, index: i })
			continue
		}
		// a response matching no outstanding command is the server pushing chat at us, which is never a repeat
		if (event.reqId === undefined) continue
		const request = outstanding.get(event.reqId)
		if (!request) continue
		outstanding.delete(event.reqId)
		if (lastResponse.get(request.command) === event.body) {
			keep[i] = false
			keep[request.index] = false
		} else {
			lastResponse.set(request.command, event.body)
		}
	}
	return events.filter((_, i) => keep[i])
}

export namespace Sel {
	// hidden is reported so the console can say how much it is keeping from you, rather than quietly dropping it
	export function view(state: Store): { events: ConsoleEvent[]; hidden: number } {
		const inTab = state.tab === 'unified' ? state.events : state.events.filter((e) => e.type === state.tab)
		if (!state.hideNoise) return { events: inTab, hidden: 0 }
		const events = denoise(inTab)
		return { events, hidden: inTab.length - events.length }
	}
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<Store>(stores.serverConsole)
	}

	export function setTab(stores: KeyProp, tab: Tab) {
		store(stores).setState({ tab })
	}

	export function setHideNoise(stores: KeyProp, hideNoise: boolean) {
		store(stores).setState({ hideNoise })
	}

	export function clear(stores: KeyProp) {
		store(stores).setState({ events: [] })
	}
}
