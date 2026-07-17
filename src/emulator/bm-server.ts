import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

// Stub BattleMetrics API. The app reaches BM for org flags, player lookup and flag/note writes;
// pointing BM_HOST at this server keeps the real BM client code paths (auth header, JSON:API
// parsing, caching) under test while staying offline and deterministic.
//
// Responses use the JSON:API shapes the app's zod schemas accept (see models/battlemetrics.models).
// State is in-memory and inspectable, so a test can assert "the app flagged this player".

export type BmFlag = { id: string; name: string; color: string; description: string; icon: string }

export type BmPlayer = {
	bmPlayerId: string
	eosId: string
	steamId?: string
	flagIds: string[]
	hoursPlayed: number
}

export type BmRequest = { method: string; path: string; body: unknown }

// real BM flag ids are uuids, and settings that reference them (playerFlagsRequiringNote) validate as much, so the
// stub's ids have to be uuids too or those settings can't be saved against it
// The org the stub claims to be. A dev instance runs with BM_ORG_ID pinned to this (see dev/instance.ts) so the app
// and the stub agree without either knowing the real org's id.
export const STUB_ORG_ID = 'stub-org'

const DEFAULT_FLAGS: BmFlag[] = [
	{ id: '00000000-0000-4000-8000-000000000001', name: 'Seeder', color: '#00ff00', description: 'Seeds the server', icon: 'star' },
	{ id: '00000000-0000-4000-8000-000000000002', name: 'Watchlist', color: '#ff0000', description: 'Under watch', icon: 'eye' },
]

export class BmServer {
	orgFlags: BmFlag[]
	// the app drops any flag not owned by its own org (see fetchPlayerDetail), so the stub has to claim an org and say
	// so on every flagPlayer, or its flags all get filtered out and a flagged player reads as unflagged
	orgId: string
	players = new Map<string, BmPlayer>()
	notes: { bmPlayerId: string; note: string }[] = []
	requestLog: BmRequest[] = []
	// a note is the only lasting trace a flag change leaves on a real profile, so the dev host prints them rather
	// than leaving them buried in memory. tests read `notes` instead.
	onNote?: (note: { bmPlayerId: string; note: string }) => void

	#server: http.Server
	#nextPlayerId = 1000

	constructor(opts?: { orgFlags?: BmFlag[]; orgId?: string }) {
		this.orgFlags = opts?.orgFlags ?? [...DEFAULT_FLAGS]
		this.orgId = opts?.orgId ?? STUB_ORG_ID
		this.#server = http.createServer((req, res) => void this.#handle(req, res))
	}

	listen(port = 0, host = '127.0.0.1'): Promise<number> {
		return new Promise((resolve, reject) => {
			this.#server.once('error', reject)
			this.#server.listen(port, host, () => {
				resolve((this.#server.address() as AddressInfo).port)
			})
		})
	}

	close() {
		this.#server.close()
	}

	// registers a player so the app's eos -> bm id lookup resolves; unregistered players simply
	// don't match, which is also what BM does for an unknown account
	addPlayer(p: { eosId: string; steamId?: string; flagIds?: string[]; hoursPlayed?: number }): BmPlayer {
		const player: BmPlayer = {
			bmPlayerId: String(this.#nextPlayerId++),
			eosId: p.eosId,
			steamId: p.steamId,
			flagIds: p.flagIds ?? [],
			hoursPlayed: p.hoursPlayed ?? 10,
		}
		this.players.set(player.bmPlayerId, player)
		return player
	}

	findByEos(eosId: string): BmPlayer | undefined {
		return [...this.players.values()].find((p) => p.eosId === eosId)
	}

	async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
		const chunks: Buffer[] = []
		for await (const chunk of req) chunks.push(chunk as Buffer)
		const raw = Buffer.concat(chunks).toString('utf8')
		const body: unknown = raw ? JSON.parse(raw) : undefined
		const url = req.url ?? ''
		const method = req.method ?? 'GET'
		this.requestLog.push({ method, path: url, body })

		const send = (status: number, payload: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(payload))
		}

		// GET /player-flags -- the org's flag definitions
		if (method === 'GET' && url.startsWith('/player-flags')) {
			return send(200, {
				data: this.orgFlags.map((f) => ({
					type: 'playerFlag',
					id: f.id,
					attributes: { name: f.name, color: f.color, description: f.description, icon: f.icon },
				})),
			})
		}

		// POST /players/quick-match -- resolve identifiers (eos ids) to bm player ids
		if (method === 'POST' && url.startsWith('/players/quick-match')) {
			const identifiers = (body as { data?: { attributes?: { identifier?: string } }[] } | undefined)?.data ?? []
			const data = identifiers.flatMap((item, i) => {
				const eosId = item.attributes?.identifier
				const player = eosId ? this.findByEos(eosId) : undefined
				if (!eosId || !player) return []
				return [{
					type: 'identifier' as const,
					id: `ident-${i}`,
					attributes: { type: 'eosID', identifier: eosId },
					relationships: { player: { data: { type: 'player' as const, id: player.bmPlayerId } } },
				}]
			})
			return send(200, { data })
		}

		const flagWrite = url.match(/^\/players\/([^/?]+)\/relationships\/flags\/?([^/?]*)/)
		if (flagWrite) {
			const player = this.players.get(flagWrite[1])
			if (!player) return send(404, { errors: [{ status: '404', title: 'Not Found' }] })
			if (method === 'POST') {
				const ids = (body as { data?: { id?: string }[] } | undefined)?.data ?? []
				for (const item of ids) {
					if (item.id && !player.flagIds.includes(item.id)) player.flagIds.push(item.id)
				}
				return send(200, { data: player.flagIds.map((id) => ({ type: 'playerFlag', id })) })
			}
			if (method === 'DELETE') {
				const flagId = flagWrite[2]
				player.flagIds = player.flagIds.filter((id) => id !== flagId)
				return send(200, { data: [] })
			}
		}

		const noteWrite = url.match(/^\/players\/([^/?]+)\/relationships\/notes/)
		if (method === 'POST' && noteWrite) {
			const note = (body as { data?: { attributes?: { note?: string } } } | undefined)?.data?.attributes?.note ?? ''
			const entry = { bmPlayerId: noteWrite[1], note }
			this.notes.push(entry)
			this.onNote?.(entry)
			return send(200, { data: { type: 'playerNote', id: String(this.notes.length) } })
		}

		// GET /players/{id} -- player detail with flags and identifiers included
		const detail = url.match(/^\/players\/([^/?]+)/)
		if (method === 'GET' && detail) {
			const player = this.players.get(detail[1])
			if (!player) return send(404, { errors: [{ status: '404', title: 'Not Found' }] })
			const included: unknown[] = [
				{ type: 'identifier', id: `eos-${player.bmPlayerId}`, attributes: { type: 'eosID', identifier: player.eosId } },
			]
			if (player.steamId) {
				included.push({
					type: 'identifier',
					id: `steam-${player.bmPlayerId}`,
					attributes: { type: 'steamID', identifier: player.steamId },
				})
			}
			for (const flagId of player.flagIds) {
				included.push({
					type: 'flagPlayer',
					id: `fp-${player.bmPlayerId}-${flagId}`,
					relationships: {
						playerFlag: { data: { type: 'playerFlag', id: flagId } },
						organization: { data: { type: 'organization', id: this.orgId } },
					},
				})
				const def = this.orgFlags.find((f) => f.id === flagId)
				if (def) {
					included.push({
						type: 'playerFlag',
						id: def.id,
						attributes: { name: def.name, color: def.color, description: def.description, icon: def.icon },
					})
				}
			}
			return send(200, {
				data: {
					type: 'player',
					id: player.bmPlayerId,
					relationships: {
						servers: { data: [{ type: 'server', id: 'stub-server', meta: { timePlayed: player.hoursPlayed * 3600 } }] },
					},
				},
				included,
			})
		}

		send(404, { errors: [{ status: '404', title: 'Not Found', detail: `stub has no route for ${method} ${url}` }] })
	}
}
