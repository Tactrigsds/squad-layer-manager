import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { RouterClient } from '@orpc/server'
import { WebSocket } from 'ws'

import * as AR from '@/app-routes'
import * as LL from '@/models/layer-list.models'
import type * as L from '@/models/layer.models'
import type * as MH from '@/models/match-history.models'
import type * as PA from '@/models/procedure-access.models'
import * as SLL from '@/models/shared-layer-list.models'

import type * as Stats from './stats'

// Simulated browser tabs: each signs in, downloads the layer data and opens the streams the dashboard opens for its
// server (see src/main.tsx and src/frames/squad-server.frame.ts). Some also act. An editor adds a layer to the queue
// and saves it, then removes it and saves again. A historian pages through the history page and opens past matches.
//
// Layer table searches run in a browser worker against the downloaded layer data, so the only server cost they
// carry is the download.

export type Role = 'viewer' | 'editor' | 'historian'

export type LoadUser = { discordId: bigint; username: string }

type Client = RouterClient<PA.ClientRouter>

const EDIT_INTERVAL_MS = 60_000
const HISTORY_INTERVAL_MS = 20_000
const POPULATION_REFRESH_MS = 60_000
// layers shipped in the app's layer data that the default pool and installed mods accept
const EDIT_LAYERS = [
	'Narva_RAAS_v1:USA+CombinedArms:RGF+CombinedArms',
	'Skorpo_RAAS_v1:USA+CombinedArms:RGF+CombinedArms',
	'Harju_RAAS_v1:RGF+Mechanized:PLA+AirAssault',
] as L.TextLayerId[]

export async function sessionCookie(appUrl: string, username: string): Promise<string> {
	const res = await fetch(`${appUrl}${AR.route('/check-auth')}?login=${encodeURIComponent(username)}`, { redirect: 'manual' })
	if (!res.ok) throw new Error(`login for ${username} failed: ${res.status} ${await res.text()}`)
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)
	if (!cookie) throw new Error(`login for ${username} returned no session cookie`)
	return cookie
}

export class LoadClient {
	readonly user: LoadUser
	readonly role: Role
	readonly serverId: string
	streamMessages = 0
	#appUrl: string
	#rec: Stats.Recorder
	#ac = new AbortController()
	#ws: WebSocket | null = null
	#client: Client | null = null
	#timers: NodeJS.Timeout[] = []
	#busy = false
	#closed = false
	// the ordinals of the matches the server streams to the dashboard, which the historian opens
	#ordinals: { first: number; last: number } | null = null

	constructor(opts: { appUrl: string; user: LoadUser; role: Role; serverId: string; recorder: Stats.Recorder }) {
		this.#appUrl = opts.appUrl
		this.user = opts.user
		this.role = opts.role
		this.serverId = opts.serverId
		this.#rec = opts.recorder
	}

	async open() {
		const cookie = await sessionCookie(this.#appUrl, this.user.username)
		const layerData = await this.#rec.time('http:layer-data', async () => {
			const res = await fetch(`${this.#appUrl}${AR.route('/layer-data.json')}`, { headers: { cookie, 'accept-encoding': 'br' } })
			await res.arrayBuffer()
			return AR.parseContentHashEtag(res.headers.get('ETag'))
		})
		if (!layerData) throw new Error(`${this.user.username} got no layer data hash`)

		const wsUrl = `${this.#appUrl.replace(/^http/, 'ws')}${AR.route('/orpc')}?layerData=${encodeURIComponent(layerData)}`
		const ws = new WebSocket(wsUrl, { headers: { cookie } })
		await new Promise<void>((resolve, reject) => {
			ws.once('open', () => resolve())
			ws.once('error', reject)
		})
		this.#ws = ws
		this.#client = createORPCClient<Client>(new RPCLink({ websocket: ws as unknown as globalThis.WebSocket }))
		this.#subscribe()
		void this.#oneShots()

		if (this.role === 'editor') this.#every(EDIT_INTERVAL_MS, () => this.#editCycle())
		if (this.role === 'historian') this.#every(HISTORY_INTERVAL_MS, () => this.#historyCycle())
	}

	// Closes the socket without aborting the streams first: an abort is a message to the server, which oRPC sends
	// after the socket has closed and then throws from outside any caller.
	close() {
		this.#closed = true
		for (const t of this.#timers) clearInterval(t)
		this.#ws?.close()
	}

	#every(ms: number, fn: () => Promise<void>) {
		// spread clients across the interval, as tabs opened at different times are
		const start = setTimeout(() => {
			void this.#guarded(fn)
			this.#timers.push(setInterval(() => void this.#guarded(fn), ms))
		}, Math.random() * ms)
		this.#timers.push(start)
	}

	async #guarded(fn: () => Promise<void>) {
		if (this.#busy || this.#closed) return
		this.#busy = true
		try {
			await fn()
		} finally {
			this.#busy = false
		}
	}

	#subscribe() {
		const c = this.#client!
		const signal = this.#ac.signal
		const serverId = this.serverId
		const streams: [string, () => Promise<AsyncIterable<unknown>>][] = [
			['config.watchConfig', () => c.config.watchConfig(undefined, { signal })],
			['announcements.watch', () => c.announcements.watch(undefined, { signal })],
			['squadServer.watchLoadedServers', () => c.squadServer.watchLoadedServers(undefined, { signal })],
			['settings.global.watchSettings', () => c.settings.global.watchSettings(undefined, { signal })],
			['settings.public.watchPublicSettings', () => c.settings.public.watchPublicSettings(undefined, { signal })],
			['filters.watchFilters', () => c.filters.watchFilters(undefined, { signal })],
			['filters.watchFilterReferences', () => c.filters.watchFilterReferences(undefined, { signal })],
			['filters.watchFilterProblems', () => c.filters.watchFilterProblems(undefined, { signal })],
			['rotations.watchChanges', () => c.rotations.watchChanges(undefined, { signal })],
			['battlemetrics.watchPlayerBmData', () => c.battlemetrics.watchPlayerBmData(undefined, { signal })],
			['users.watchUserInvalidation', () => c.users.watchUserInvalidation(undefined, { signal })],
			['userPresence.watchUpdates', () => c.userPresence.watchUpdates(undefined, { signal })],
			['plugins.watchPlugins', () => c.plugins.watchPlugins(undefined, { signal })],
			['timeouts.watchActiveTimeouts', () => c.timeouts.watchActiveTimeouts(undefined, { signal })],
			['squadServer.watchServerInfo', () => c.squadServer.watchServerInfo({ serverId }, { signal })],
			['squadServer.watchLayersStatus', () => c.squadServer.watchLayersStatus({ serverId }, { signal })],
			['squadServer.watchServerRolling', () => c.squadServer.watchServerRolling({ serverId }, { signal })],
			['squadServer.watchTickRate', () => c.squadServer.watchTickRate({ serverId }, { signal })],
			['vote.watchUpdates', () => c.vote.watchUpdates({ serverId }, { signal })],
			['matchHistory.watchMatchHistoryState', () => c.matchHistory.watchMatchHistoryState({ serverId }, { signal })],
			['layerQueue.watchNextLayerSyncState', () => c.layerQueue.watchNextLayerSyncState({ serverId }, { signal })],
			['layerQueue.watchIngameVote', () => c.layerQueue.watchIngameVote({ serverId }, { signal })],
			['layerQueue.watchOps', () => c.layerQueue.watchOps({ serverId }, { signal })],
			['squadServer.watchChatEvents', () => c.squadServer.watchChatEvents({ serverId }, { signal })],
			['settings.server.watchSettings', () => c.settings.server.watchSettings({ serverId }, { signal })],
			['teamswaps.watchUpdates', () => c.teamswaps.watchUpdates({ serverId }, { signal })],
			['switchRequests.watchUpdates', () => c.switchRequests.watchUpdates({ serverId }, { signal })],
		]
		for (const [name, open] of streams)
			void this.#drain(name, open, name === 'matchHistory.watchMatchHistoryState' ? (m) => this.#trackOrdinals(m) : undefined)
	}

	#trackOrdinals(message: unknown) {
		const m = message as Partial<MH.PublicMatchHistoryUpdate>
		if (m.code === 'state' && m.recentMatches && m.recentMatches.length > 0) {
			this.#ordinals = { first: m.recentMatches[0].ordinal, last: m.recentMatches.at(-1)!.ordinal }
		} else if (m.code === 'patch' && m.firstOrdinal != null && m.lastOrdinal != null) {
			this.#ordinals = { first: m.firstOrdinal, last: m.lastOrdinal }
		}
	}

	// the time to the first message is what a page load waits on
	async #drain(name: string, open: () => Promise<AsyncIterable<unknown>>, onMessage?: (message: unknown) => void) {
		const start = performance.now()
		let first = true
		try {
			for await (const message of await open()) {
				onMessage?.(message)
				if (first) {
					this.#rec.record(`first:${name}`, performance.now() - start)
					first = false
				}
				this.streamMessages++
			}
		} catch {
			if (!this.#closed) this.#rec.error(`stream:${name}`)
		}
	}

	async #oneShots() {
		const c = this.#client!
		const signal = this.#ac.signal
		const serverId = this.serverId
		await Promise.all([
			this.#rec.time('rpc:users.getLoggedInUser', () => c.users.getLoggedInUser(undefined, { signal })),
			this.#rec.time('rpc:users.getMyLinkedSteamAccounts', () => c.users.getMyLinkedSteamAccounts(undefined, { signal })),
			this.#rec.time('rpc:battlemetrics.listOrgFlags', () => c.battlemetrics.listOrgFlags(undefined, { signal })),
			this.#rec.time('rpc:changelog.getStatus', () => c.changelog.getStatus(undefined, { signal })),
			this.#rec.time('rpc:tutorials.list', () => c.tutorials.list(undefined, { signal })),
			this.#rec.time('rpc:tutorials.getProgress', () => c.tutorials.getProgress(undefined, { signal })),
			this.#rec.time('rpc:tutorials.getDismissedPrompts', () => c.tutorials.getDismissedPrompts(undefined, { signal })),
		])
		this.#every(POPULATION_REFRESH_MS, async () => {
			await this.#rec.time('rpc:matchHistory.getPopulation', () => c.matchHistory.getPopulation({ serverId, range: '24h' }, { signal }))
		})
	}

	// A queue session of its own for each cycle, read for the edit window its ops have to name. The dashboard's
	// watchOps stream above carries the same updates, but tracking the window from it would mean replaying the
	// shared list model here.
	async #editCycle() {
		const c = this.#client!
		const ac = new AbortController()
		const signal = AbortSignal.any([this.#ac.signal, ac.signal])
		try {
			const stream = (await c.layerQueue.watchOps({ serverId: this.serverId }, { signal }))[Symbol.asyncIterator]()
			const init = (await stream.next()).value
			if (!init || init.code !== 'init') return this.#rec.error('edit:session')
			const window = init.state.editWindowSeqId
			const userId = this.user.discordId
			const layerId = EDIT_LAYERS[Math.floor(Math.random() * EDIT_LAYERS.length)]
			const item = LL.createItem({ type: 'single-list-item', layerId }, { type: 'manual', userId })
			const dispatch = (name: string, op: SLL.Operation) =>
				this.#rec.time(`edit:${name}`, async () => {
					const res = await c.layerQueue.dispatchOp({ serverId: this.serverId, op }, { signal })
					if (res.code !== 'ok') throw new Error(res.code)
				})
			const base = { editWindowSeqId: window, userId }
			await dispatch('add', { ...base, op: 'add', opId: SLL.createOpId(), items: [item], index: { outerIndex: 0, innerIndex: null } })
			await dispatch('save', { ...base, op: 'save', opId: SLL.createOpId() })
			await dispatch('delete', { ...base, editWindowSeqId: window + 1, op: 'delete', opId: SLL.createOpId(), itemId: item.itemId })
			await dispatch('save', { ...base, editWindowSeqId: window + 1, op: 'save', opId: SLL.createOpId() })
		} catch {
			if (!this.#closed) this.#rec.error('edit:cycle')
		} finally {
			if (!this.#closed) ac.abort()
		}
	}

	async #historyCycle() {
		const c = this.#client!
		const signal = this.#ac.signal
		const page = await this.#rec.time('history:events', () => c.history.query({ query: {}, includeMatchBoundaries: true }, { signal }))
		const cursor = page && 'cursor' in page ? (page.cursor as { time: number } | undefined) : undefined
		if (cursor)
			await this.#rec.time('history:events-next', () => c.history.query({ query: {}, cursor, includeMatchBoundaries: true }, { signal }))
		await this.#rec.time('history:players', () => c.history.query({ query: { type: 'players' }, page: 0 }, { signal }))
		await this.#rec.time('history:matches', () => c.history.query({ query: { type: 'matches' }, page: 0 }, { signal }))
		const ordinals = this.#ordinals
		if (!ordinals) return
		const ordinal = ordinals.first + Math.floor(Math.random() * (ordinals.last - ordinals.first + 1))
		await this.#rec.time('history:match-events', () => c.matchHistory.getMatchEvents({ serverId: this.serverId, ordinal }, { signal }))
	}
}
