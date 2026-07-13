import type { MigrationDriver } from '@/server/migrate'
import superjson from 'superjson'

// Renamed the "teamswitches" nomenclature to "teamswaps" throughout the app. Three persisted spots need updating:
//  - `servers.teamswitches` (the saved-but-not-yet-executed swap queue) -> `servers.teamswaps`. A plain column
//    rename; the JSON payload's own shape (`{ switches, matchHistoryEntryId }`) is left alone here because
//    ServerStateSchema's preprocess step already treats that old shape as unrecoverable and resets it to null (it's
//    a transient "queued for next map" value, so dropping it on upgrade is an acceptable loss).
//  - the `TEAMSWITCHES_UPDATED` app-event type -> `TEAMSWAPS_UPDATED`, whose payload also renamed the fields
//    `switches`/`prevSwitches` -> `swaps`/`prevSwaps`. Unlike the queue above, this is the permanent audit log, so
//    old rows are fully rewritten (round-tripped through superjson to keep the `Map` fields intact) rather than
//    left to fail validation and drop out of the feed (see AppEvents.fromRow).
//  - the five renamed chat command ids (switchNow, switchNext, switchSquadNow, switchSquadNext, clearSwitches) in
//    `globalSettings.settings.commands`, so an admin's customized strings/scopes/enabled survive the rename instead
//    of silently reverting to the new code defaults.
//
// `settings` and `data` are stored superjson-wrapped ({ json, meta }) in drizzle json(text) columns.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`ALTER TABLE servers RENAME COLUMN teamswitches TO teamswaps`)

	const events = db.prepare(`SELECT id, data FROM appEvents WHERE type = 'TEAMSWITCHES_UPDATED'`).all() as {
		id: string
		data: string
	}[]
	const updateEvent = db.prepare(`UPDATE appEvents SET type = 'TEAMSWAPS_UPDATED', data = ? WHERE id = ?`)
	for (const row of events) {
		const revived = superjson.deserialize(JSON.parse(row.data)) as Record<string, unknown>
		if ('switches' in revived) {
			revived.swaps = revived.switches
			delete revived.switches
		}
		if ('prevSwitches' in revived) {
			revived.prevSwaps = revived.prevSwitches
			delete revived.prevSwitches
		}
		revived.type = 'TEAMSWAPS_UPDATED'
		updateEvent.run(JSON.stringify(superjson.serialize(revived)), row.id)
	}

	const settingsRow = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (settingsRow?.settings) {
		const wrapper = JSON.parse(settingsRow.settings) as { json?: any; meta?: any }
		const commands = wrapper?.json?.commands
		if (commands && typeof commands === 'object') {
			const RENAMES: [string, string][] = [
				['switchNow', 'swapNow'],
				['switchNext', 'swapNext'],
				['switchSquadNow', 'swapSquadNow'],
				['switchSquadNext', 'swapSquadNext'],
				['clearSwitches', 'clearSwaps'],
			]
			let changed = false
			for (const [oldId, newId] of RENAMES) {
				if (commands[oldId] !== undefined && commands[newId] === undefined) {
					commands[newId] = commands[oldId]
					delete commands[oldId]
					changed = true
				}
			}
			if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
		}
	}
}
