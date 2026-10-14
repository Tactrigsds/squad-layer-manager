import type * as FRM from '@/lib/frame'
import * as RSel from '@/lib/reselect'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as SC_Msgs from '@/messages/server-console.messages'
import type { ConsoleEvent } from '@/models/server-console.models'
import * as SC from '@/models/server-console.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'

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

export type Store = {
	serverId: string
	events: ConsoleEvent[]
	tab: SC.ConsoleChannel
	hideNoise: boolean
	showSlmRequests: boolean
	showEvents: boolean
	denied: boolean
	executing: boolean
	executeError: string | null
	// the CommandHistoryStore entry the input shows, or null on the line being typed, which is kept in historyDraft
	// while recalling
	historyCursor: number | null
	historyDraft: string
}

function createKey(frameId: symbol, input: Input): Types['key'] {
	return { frameId, serverId: input.serverId }
}

function setup(args: FRM.SetupArgs<Input, Store>) {
	const { serverId } = args.input
	args.set({
		serverId,
		events: [],
		tab: 'rcon',
		hideNoise: true,
		showSlmRequests: false,
		showEvents: false,
		denied: false,
		executing: false,
		executeError: null,
		historyCursor: null,
		historyDraft: '',
	} satisfies Store)

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

const COMMAND_HISTORY_KEY = 'rconCommandHistory:v1'

function readCommandHistory(): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(COMMAND_HISTORY_KEY) ?? '[]')
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
	} catch {
		return []
	}
}

// The rcon commands this browser has run from any console, oldest first, for recall with the arrow keys. Shared by
// every server and window, like a shell's history file.
export const CommandHistoryStore = Zus.createStore<{ commands: string[] }>((_set, _get, store) => {
	store.subscribe((state, prev) => {
		if (state.commands !== prev.commands) localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(state.commands))
	})
	return { commands: readCommandHistory() }
})

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
		// a command someone typed is never a repeat, however often they type it
		if (event.type !== 'rcon' || event.issuer !== undefined) continue
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
	export const view = RSel.createSelector(
		[
			(state: Store) => state.events,
			(state: Store) => state.tab,
			(state: Store) => state.hideNoise,
			(state: Store) => state.showSlmRequests,
			(state: Store) => state.showEvents,
		],
		(allEvents, tab, hideNoise, showSlmRequests, showEvents): { events: ConsoleEvent[]; hidden: number } => {
			const inTab = allEvents.filter((e) => {
				if (e.type !== tab) return false
				if (e.type !== 'rcon') return true
				const kind = SC.rconKind(e)
				switch (kind) {
					case 'user':
						return true
					case 'request':
						return showSlmRequests
					case 'event':
						return showEvents
					default:
						assertNever(kind)
				}
			})
			if (!hideNoise) return { events: inTab, hidden: 0 }
			const events = denoise(inTab)
			return { events, hidden: inTab.length - events.length }
		},
	)
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<Store>(stores.serverConsole)
	}

	export function setTab(stores: KeyProp, tab: SC.ConsoleChannel) {
		store(stores).setState({ tab })
	}

	export function setHideNoise(stores: KeyProp, hideNoise: boolean) {
		store(stores).setState({ hideNoise })
	}

	export function setShowSlmRequests(stores: KeyProp, showSlmRequests: boolean) {
		store(stores).setState({ showSlmRequests })
	}

	export function setShowEvents(stores: KeyProp, showEvents: boolean) {
		store(stores).setState({ showEvents })
	}

	export function clear(stores: KeyProp) {
		store(stores).setState({ events: [] })
	}

	// Steps through the commands run from this window the way a shell does: up recalls older ones, and down past the
	// newest returns to the line that was being typed.
	export function recallCommand(stores: KeyProp, input: HTMLInputElement, direction: 'older' | 'newer') {
		const s = store(stores)
		const { historyCursor: held, historyDraft } = s.getState()
		const commandHistory = CommandHistoryStore.getState().commands
		if (commandHistory.length === 0) return
		// another window can trim the history while this one is recalling from it
		const historyCursor = held === null ? null : Math.min(held, commandHistory.length - 1)
		let cursor: number | null
		if (direction === 'older') {
			cursor = historyCursor === null ? commandHistory.length - 1 : Math.max(0, historyCursor - 1)
		} else {
			if (historyCursor === null) return
			cursor = historyCursor + 1 < commandHistory.length ? historyCursor + 1 : null
		}
		const draft = historyCursor === null ? input.value : historyDraft
		s.setState({ historyCursor: cursor, historyDraft: draft })
		input.value = cursor === null ? draft : commandHistory[cursor]
		input.setSelectionRange(input.value.length, input.value.length)
	}

	// Clears the input once the server has the command. On failure the input keeps the command so it can be retried.
	export async function execute(stores: KeyProp, input: HTMLInputElement) {
		const command = input.value.trim()
		const s = store(stores)
		if (!command || s.getState().executing) return
		const history = CommandHistoryStore.getState().commands
		if (history[history.length - 1] !== command) {
			CommandHistoryStore.setState({ commands: [...history, command].slice(-SC.COMMAND_HISTORY_SIZE) })
		}
		s.setState({ executing: true, executeError: null, historyCursor: null, historyDraft: '' })
		try {
			const res = await RPC.orpc.serverConsole.execute.call({ serverId: s.getState().serverId, command })
			switch (res.code) {
				case 'ok':
					input.value = ''
					s.setState({ executeError: null })
					break
				case 'err:rcon':
				case 'err:server-not-loaded':
					s.setState({ executeError: res.msg })
					break
				case 'err:permission-denied':
					s.setState({ executeError: tr.text(SC_Msgs.commandDenied()) })
					break
				default:
					assertNever(res)
			}
		} catch (err) {
			s.setState({ executeError: err instanceof Error ? err.message : String(err) })
		} finally {
			s.setState({ executing: false })
		}
	}
}
