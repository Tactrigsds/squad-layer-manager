import type { MigrationDriver } from '@/server/migrate'

// Makes app events searchable alongside server events on the history page.
//
// `appEvents` is already its own permanent index -- it is never compacted, and it carries time, server, match
// and type as columns -- so all it gains is `feedVisible`, the queryable projection of AppEvents.isFeedVisible.
// Without it a search returns audit-only events the feed has never drawn, and the page comes up short of its
// own result count when the renderer draws nothing for them.
//
// `appEventAssociations` is the many-valued half: what an event is *about*, one row per value. It is generic
// over the dimension (a player, a layer) rather than a table per kind, because the two have identical query
// shapes and the write path is one walk over the event's metas (see event-meta.models.ts) -- a third dimension
// is an extractor and a new `dimension` value, not another migration.
//
// Deliberately NOT how server events are indexed: playerEventIndex is a dedicated, tuned table because it
// carries millions of rows, where every app event ever recorded is a few thousand. Size is the whole reason
// for the asymmetry.
//
// Both are backfilled by the app rather than here: the values come from evaluating typescript extractors
// against a superjson payload, which sql cannot do. See backfillAppEventIndex.
export async function up(db: MigrationDriver): Promise<void> {
	// null until the backfill runs, so a partially migrated install returns nothing rather than everything
	db.exec(`ALTER TABLE appEvents ADD COLUMN feedVisible INTEGER`)
	db.exec(`CREATE INDEX appEventFeedVisibleIndex ON appEvents (feedVisible, time)`)

	// pk ordered for the query that dominates: everything about one player (or one layer), newest first, as one
	// contiguous range. WITHOUT ROWID so the pk is the table.
	db.exec(`CREATE TABLE appEventAssociations (
		dimension TEXT NOT NULL,
		value TEXT NOT NULL,
		time INTEGER NOT NULL,
		appEventId TEXT NOT NULL REFERENCES appEvents(id) ON DELETE CASCADE,
		role TEXT NOT NULL,
		PRIMARY KEY (dimension, value, time, appEventId, role)
	) WITHOUT ROWID`)
	// the reverse direction, which is what the cascade delete walks
	db.exec(`CREATE INDEX appEventAssociationsEventIdIndex ON appEventAssociations (appEventId)`)
}
