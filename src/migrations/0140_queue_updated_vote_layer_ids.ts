import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Ending a vote with a winner wrote the winning layer onto the saved queue's own vote item before set-vote-result
// ran, so the QUEUE_UPDATED that recorded the result carried a prevList whose vote item named the winner as its
// layer while still undecided. A vote item's layerId must be its first choice until it has a winner, so those rows
// failed to parse and dropped out of the audit log and the match feed.
//
// The repair gives each undecided vote item in prevList and list its first choice's layer, which is what that item
// held before the write. feedVisible is reset to null so the app-event index backfill re-indexes the rows at the
// next boot: a row that was unparseable when the backfill first ran was marked invisible and given no associations.
type ListItem = {
	type?: unknown
	layerId?: unknown
	choices?: { layerId?: unknown }[]
	endingVoteState?: { code?: unknown }
}

function repairList(list: unknown): boolean {
	if (!Array.isArray(list)) return false
	let changed = false
	for (const item of list as ListItem[]) {
		if (item?.type !== 'vote-list-item' || item.endingVoteState?.code === 'ended:winner') continue
		const first = item.choices?.[0]?.layerId
		if (typeof first !== 'string' || item.layerId === first) continue
		item.layerId = first
		changed = true
	}
	return changed
}

const undecidedVoteMismatch = (path: string) => `EXISTS (
	SELECT 1 FROM json_each(appEvents.data, '${path}') AS item
	WHERE json_extract(item.value, '$.type') = 'vote-list-item'
		AND json_extract(item.value, '$.endingVoteState.code') IS NOT 'ended:winner'
		AND json_extract(item.value, '$.layerId') IS NOT json_extract(item.value, '$.choices[0].layerId')
)`

export async function up(db: MigrationDriver): Promise<void> {
	const rows = db
		.prepare(
			`SELECT id, data FROM appEvents
			WHERE type = 'QUEUE_UPDATED' AND (${undecidedVoteMismatch('$.json.prevList')} OR ${undecidedVoteMismatch('$.json.list')})`,
		)
		.all() as { id: string; data: string }[]
	const update = db.prepare(`UPDATE appEvents SET data = ?, feedVisible = NULL WHERE id = ?`)
	let repaired = 0
	for (const row of rows) {
		const payload = superjson.parse(row.data) as { prevList?: unknown; list?: unknown }
		const prevChanged = repairList(payload.prevList)
		const listChanged = repairList(payload.list)
		if (!prevChanged && !listChanged) continue
		update.run(superjson.stringify(payload), row.id)
		repaired++
	}
	if (repaired > 0) console.info(`0140_queue_updated_vote_layer_ids: repaired ${repaired} QUEUE_UPDATED row(s)`)
}
