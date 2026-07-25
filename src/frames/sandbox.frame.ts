import type * as FRM from '@/lib/frame'
import * as ZusUtils from '@/lib/zustand'
import type { EmuEvent } from '@/models/sandbox.models'
import type * as SB from '@/models/sandbox.models'
import * as RPC from '@/orpc.client'
import type { SandboxState } from '@/systems/sandbox.shared'

import { frameManager } from './frame-manager'

// All the sandbox control window's state, so the window and its pop-outs read one source rather than each holding
// their own copy of a live stream. Keyed by server: two sandboxes are two independent worlds.

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>
export type Input = { serverId: string }
export type Types = {
	name: 'sandbox'
	key: FRM.RawInstanceKey<{ serverId: string }>
	input: Input
	state: Store
}

export type ConsoleChannel = 'unified' | 'rcon' | 'log' | 'command'
export const CONSOLE_CHANNELS: ConsoleChannel[] = ['unified', 'rcon', 'log', 'command']

// The console is a tail, not a transcript: a busy world produces log lines indefinitely and nothing here is
// persisted, so old entries are dropped rather than growing the tab forever.
const MAX_EVENTS = 500

export const PLAYERS_PAGE_SIZE = 15

export type Store = {
	serverId: string
	// null until the first stream frame arrives, or when the server stops being a sandbox
	state: SandboxState | null
	unavailable: boolean
	events: EmuEvent[]
	channel: ConsoleChannel
	hideNoise: boolean
	playerSearch: string
	playerPage: number
	// who the chat box speaks as, held rather than derived so it survives the roster changing under it
	speaker: string | null
	chatChannel: SB.PlayerChatChannel
}

function createKey(frameId: symbol, input: Input): Types['key'] {
	return { frameId, serverId: input.serverId }
}

function setup(args: FRM.SetupArgs<Input, Store>) {
	const { serverId } = args.input
	args.set(
		{
			serverId,
			state: null,
			unavailable: false,
			events: [],
			channel: 'unified',
			hideNoise: true,
			playerSearch: '',
			playerPage: 0,
			speaker: null,
			chatChannel: 'ChatAll',
		} satisfies Store,
	)

	args.sub.add(
		RPC.observe(`sandbox.watchState:${serverId}`, () => RPC.orpc.sandbox.watchState.call({ serverId }))
			.subscribe((res) => {
				if (res.code === 'ok') args.set({ state: res, unavailable: false })
				else args.set({ state: null, unavailable: true })
			}),
	)

	args.sub.add(
		RPC.observe(`sandbox.watchEvents:${serverId}`, () => RPC.orpc.sandbox.watchEvents.call({ serverId }))
			.subscribe((batch) => {
				const prev = args.get().events
				const next = prev.concat(batch)
				args.set({ events: next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next })
			}),
	)
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'sandbox',
	createKey,
	setup,
})

const TICK_RATE_LINE = /Server Tick Rate:/

// SLM polls the same handful of rcon commands on a timer and the game reports its tick rate on another, so most of
// what a quiet world produces says only that nothing has changed. Dropping it is what makes the console readable at
// a glance; the checkbox is there because "nothing changed" is occasionally the thing being diagnosed.
function denoise(events: readonly EmuEvent[]): EmuEvent[] {
	const keep = new Array<boolean>(events.length).fill(true)
	const lastResponse = new Map<string, string>()
	let pending: { command: string; index: number } | null = null
	for (let i = 0; i < events.length; i++) {
		const event = events[i]
		if (event.type === 'log') {
			if (TICK_RATE_LINE.test(event.line)) keep[i] = false
			continue
		}
		if (event.type !== 'rcon') continue
		if (event.dir === 'recv') {
			pending = { command: event.body, index: i }
			continue
		}
		// a send with no command outstanding is the server pushing chat at us, which is never a repeat
		if (!pending) continue
		const { command, index } = pending
		pending = null
		if (lastResponse.get(command) === event.body) {
			keep[i] = false
			keep[index] = false
		} else {
			lastResponse.set(command, event.body)
		}
	}
	return events.filter((_, i) => keep[i])
}

export namespace Sel {
	const EMPTY: never[] = []

	export function players(state: Store) {
		return state.state?.players ?? EMPTY
	}

	// One page of the roster, filtered by name. The page is clamped here rather than corrected on every roster
	// change: players leave without asking the window first, and a page that no longer exists should show the last
	// one, not nothing.
	export function playersView(state: Store): {
		players: SandboxState['players']
		page: number
		pageCount: number
		matched: number
		total: number
	} {
		const all = players(state)
		const needle = state.playerSearch.trim().toLowerCase()
		const matched = needle ? all.filter((p: SandboxState['players'][number]) => p.name.toLowerCase().includes(needle)) : all
		const pageCount = Math.max(1, Math.ceil(matched.length / PLAYERS_PAGE_SIZE))
		const page = Math.min(Math.max(state.playerPage, 0), pageCount - 1)
		return {
			players: matched.slice(page * PLAYERS_PAGE_SIZE, (page + 1) * PLAYERS_PAGE_SIZE),
			page,
			pageCount,
			matched: matched.length,
			total: all.length,
		}
	}

	export function groupNames(state: Store): string[] {
		return state.state?.groups.map((g: SandboxState['groups'][number]) => g.name) ?? EMPTY
	}

	export function adminsCfg(state: Store): string {
		return state.state?.adminsCfg ?? ''
	}

	// the name a new player would get, so the join field can offer it rather than demanding one
	export function nextDefaultName(state: Store): string {
		return state.state?.nextDefaultName ?? 'Player1'
	}

	// The speaker the chat box acts as. Falls back to the first player so the box is usable the moment anyone
	// joins, and drops a speaker who has left rather than sending as a ghost.
	export function activeSpeaker(state: Store): SandboxState['players'][number] | null {
		const list = players(state)
		const held = state.speaker ? list.find((p: SandboxState['players'][number]) => p.name === state.speaker) : undefined
		return held ?? list[0] ?? null
	}

	// A non-admin cannot speak in admin chat on a real server, so the option is withheld rather than offered and
	// rejected. Kept as a selector so the select and the send path cannot disagree about it.
	export function availableChatChannels(state: Store): SB.PlayerChatChannel[] {
		const speaker = activeSpeaker(state)
		const base: SB.PlayerChatChannel[] = ['ChatAll', 'ChatTeam', 'ChatSquad']
		return speaker?.isAdmin ? [...base, 'ChatAdmin'] : base
	}

	export function effectiveChatChannel(state: Store): SB.PlayerChatChannel {
		const available = availableChatChannels(state)
		return available.includes(state.chatChannel) ? state.chatChannel : 'ChatAll'
	}

	// hidden is reported so the console can say how much it is keeping from you, rather than quietly dropping it
	export function consoleView(state: Store): { events: EmuEvent[]; hidden: number } {
		const inChannel = state.channel === 'unified' ? state.events : state.events.filter((e) => e.type === state.channel)
		if (!state.hideNoise) return { events: inChannel, hidden: 0 }
		const events = denoise(inChannel)
		return { events, hidden: inChannel.length - events.length }
	}
}

export namespace Actions {
	function store(stores: KeyProp) {
		return ZusUtils.resolveStore<Store>(stores.sandbox)
	}

	export function setChannel(stores: KeyProp, channel: ConsoleChannel) {
		store(stores).setState({ channel })
	}

	export function setSpeaker(stores: KeyProp, speaker: string) {
		store(stores).setState({ speaker })
	}

	export function setChatChannel(stores: KeyProp, chatChannel: SB.PlayerChatChannel) {
		store(stores).setState({ chatChannel })
	}

	export function setPlayerSearch(stores: KeyProp, playerSearch: string) {
		store(stores).setState({ playerSearch, playerPage: 0 })
	}

	export function setPlayerPage(stores: KeyProp, playerPage: number) {
		store(stores).setState({ playerPage })
	}

	export function setHideNoise(stores: KeyProp, hideNoise: boolean) {
		store(stores).setState({ hideNoise })
	}

	export function clearConsole(stores: KeyProp) {
		store(stores).setState({ events: [] })
	}

	// Every mutation is a verb, so the window has one way to change the world and the server has one place to
	// authorize it. The result is pushed back through watchState rather than applied optimistically: the emulator
	// is the source of truth and it is in-process, so the round trip is not worth guessing about.
	export async function run<V extends SB.SandboxVerb>(stores: KeyProp, verb: V, args: SB.SandboxVerbInput<V>) {
		const serverId = store(stores).getState().serverId
		return await RPC.orpc.sandbox.execute.call({ serverId, verb, args })
	}
}
