import type { EmuPlayer } from '@/emulator'
import * as BB from '@/models/backburner.models'

import type { AppFixture } from './app-fixture'

// Readers over a fixture's persisted state and RCON traffic, for assertions. Each db reader opens a
// fresh read-only connection, so it sees the app's latest committed write rather than a held snapshot.

// the layerQueue column is superjson-encoded, so the payload sits under `.json`
export function savedQueue(app: AppFixture, serverId: string = app.serverId): { type: string; itemId: string; layerId?: string }[] {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(serverId) as { layerQueue: string }
		return JSON.parse(row.layerQueue).json
	} finally {
		db.close()
	}
}

export function savedBackburner(app: AppFixture): { itemId: string; description: string }[] {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT backburner FROM servers WHERE id = ?`).get(app.serverId) as { backburner: string }
		const items = JSON.parse(row.backburner).json as { itemId: string; filter: Parameters<typeof BB.describeTemplate>[0] }[]
		return items.map((item) => ({ itemId: item.itemId, description: BB.describeTemplate(item.filter) }))
	} finally {
		db.close()
	}
}

export function savedPool(app: AppFixture): {
	skipWarningsForTags?: string[]
	repeatRules: { field: string; label?: string; autogen?: boolean; targetValues?: string[] }[]
} {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(app.serverId) as { settings: string }
		return JSON.parse(row.settings).json.queue.mainPool
	} finally {
		db.close()
	}
}

export function latestMatch(app: AppFixture): { id: number; layerId: string } {
	const db = app.readDb()
	try {
		return db.prepare(`SELECT id, layerId FROM matchHistory ORDER BY id DESC LIMIT 1`).get() as { id: number; layerId: string }
	} finally {
		db.close()
	}
}

// a match's ordinal on its server, which is what the match-history read api takes rather than the row id
export function matchOrdinal(app: AppFixture, matchId: number): number {
	const db = app.readDb()
	try {
		return (db.prepare(`SELECT ordinal FROM matchHistory WHERE id = ?`).get(matchId) as { ordinal: number }).ordinal
	} finally {
		db.close()
	}
}

export function appEventTypes(app: AppFixture, matchId?: number): string[] {
	const db = app.readDb()
	try {
		const rows = (
			matchId === undefined
				? db.prepare(`SELECT type FROM appEvents`).all()
				: db.prepare(`SELECT type FROM appEvents WHERE matchId = ?`).all(matchId)
		) as { type: string }[]
		return rows.map((r) => r.type)
	} finally {
		db.close()
	}
}

// how many chat messages a history search over this text will find. The fts index joined to the event index
// the query anchors on, because the two are written separately and only their intersection is reachable: an
// event whose player the app has not persisted yet is dropped from the event index and never retried, while
// its text lands in the fts index regardless.
export function searchableChatMatches(app: AppFixture, needle: string): number {
	const db = app.readDb()
	try {
		const row = db
			.prepare(
				`SELECT count(*) AS n FROM playerEventIndex
				 WHERE serverEventId IN (SELECT serverEventId FROM chatSearch WHERE chatSearch MATCH ?)`,
			)
			.get(needle) as { n: number }
		return row.n
	} finally {
		db.close()
	}
}

// how many of a player's events reached the history index. Zero until the app has persisted the player, so
// this is what says an arranged join has landed and the player's later events will be indexed rather than
// dropped.
export function indexedEventsFor(app: AppFixture, eosId: string): number {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT count(*) AS n FROM playerEventIndex WHERE playerId = ?`).get(eosId) as { n: number }
		return row.n
	} finally {
		db.close()
	}
}

// every AdminWarn the app addressed to this player, in order. Warns name their target by eos or steam id.
export function warnsTo(app: AppFixture, player: Pick<EmuPlayer, 'eos' | 'steam'>): string[] {
	return app.emu.rcon.commandLog
		.filter((c) => c.body.startsWith('AdminWarn') && (c.body.includes(player.eos) || c.body.includes(player.steam)))
		.map((c) => c.body)
}
