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

export function latestMatch(app: AppFixture): { id: number; layerId: string } {
	const db = app.readDb()
	try {
		return db.prepare(`SELECT id, layerId FROM matchHistory ORDER BY id DESC LIMIT 1`).get() as { id: number; layerId: string }
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

// every AdminWarn the app addressed to this player, in order. Warns name their target by eos or steam id.
export function warnsTo(app: AppFixture, player: Pick<EmuPlayer, 'eos' | 'steam'>): string[] {
	return app.emu.rcon.commandLog
		.filter((c) => c.body.startsWith('AdminWarn') && (c.body.includes(player.eos) || c.body.includes(player.steam)))
		.map((c) => c.body)
}
