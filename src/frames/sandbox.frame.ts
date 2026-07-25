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

export type Store = {
	serverId: string
	// null until the first stream frame arrives, or when the server stops being a sandbox
	state: SandboxState | null
	unavailable: boolean
	events: EmuEvent[]
	channel: ConsoleChannel
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

export namespace Sel {
	const EMPTY: never[] = []

	export function players(state: Store) {
		return state.state?.players ?? EMPTY
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

	export function visibleEvents(state: Store): EmuEvent[] {
		if (state.channel === 'unified') return state.events
		return state.events.filter((e) => e.type === state.channel)
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
