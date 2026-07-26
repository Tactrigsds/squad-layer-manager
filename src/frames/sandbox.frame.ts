import type * as FRM from '@/lib/frame'
import * as Zus from '@/lib/zustand'
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

export const PLAYERS_PAGE_SIZE = 15

export type Store = {
	serverId: string
	// null until the first stream frame arrives, or when the server stops being a sandbox
	state: SandboxState | null
	unavailable: boolean
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
	args.set({
		serverId,
		state: null,
		unavailable: false,
		playerSearch: '',
		playerPage: 0,
		speaker: null,
		chatChannel: 'ChatAll',
	} satisfies Store)

	args.cleanup.push(
		RPC.observe(`sandbox.watchState:${serverId}`, () => RPC.orpc.sandbox.watchState.call({ serverId })).subscribe((res) => {
			if (res.code === 'ok') args.set({ state: res, unavailable: false })
			else args.set({ state: null, unavailable: true })
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
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<Store>(stores.sandbox)
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

	// Every mutation is a verb, so the window has one way to change the world and the server has one place to
	// authorize it. The result is pushed back through watchState rather than applied optimistically: the emulator
	// is the source of truth and it is in-process, so the round trip is not worth guessing about.
	export async function run<V extends SB.SandboxVerb>(stores: KeyProp, verb: V, args: SB.SandboxVerbInput<V>) {
		const serverId = store(stores).getState().serverId
		return await RPC.orpc.sandbox.execute.call({ serverId, verb, args })
	}
}
