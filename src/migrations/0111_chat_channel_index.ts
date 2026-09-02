import zlib from 'node:zlib'

import type { MigrationDriver } from '@/server/migrate'

// Adds the chat channel to playerEventIndex, so "admin chat" is a filter the index can answer rather than a
// guess made from the event type.
//
// Last column on purpose: sqlite trims a record at its final non-null column, so one that only chat rows fill
// costs nothing on the combat rows that are the bulk of this table.
//
// Backfilled from both places a past chat message can live. The hot table is the usual one; the archive is
// read too, because a message compacted before this ran has no other source and would otherwise be missing
// from every channel filter forever, silently. An install that has not compacted yet has no archive rows and
// pays nothing for the second pass.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`ALTER TABLE playerEventIndex ADD COLUMN channel TEXT`)

	db.exec(`UPDATE playerEventIndex SET channel = (
		SELECT json_extract(se.data, '$.json.channel.type') FROM serverEvents se WHERE se.id = playerEventIndex.serverEventId
	) WHERE type = 'CHAT_MESSAGE'`)

	// the archive's encoding, inlined rather than imported like everything else here: what this migration
	// decoded must not change when the app's archive format gains a version
	const ENCODING = 'zstd-json-v1'
	type PackedEvent = { id: number; type: string; data: { json?: { channel?: { type?: string } } } | null }

	const archived = db.prepare(`SELECT matchId, events FROM archivedMatches WHERE encoding = ?`).all(ENCODING) as {
		matchId: number
		events: Buffer
	}[]
	const update = db.prepare(`UPDATE playerEventIndex SET channel = ? WHERE serverEventId = ? AND type = 'CHAT_MESSAGE'`)
	for (const row of archived) {
		const packed = JSON.parse(zlib.zstdDecompressSync(row.events).toString('utf8')) as PackedEvent[]
		for (const event of packed) {
			if (event.type !== 'CHAT_MESSAGE') continue
			const channel = event.data?.json?.channel?.type
			if (channel) update.run(channel, event.id)
		}
	}
}
