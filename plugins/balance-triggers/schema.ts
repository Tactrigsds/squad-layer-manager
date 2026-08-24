import * as D from 'drizzle-orm/sqlite-core'

import { defineTables } from 'slm/plugin'

import manifest from './plugin.ts'

// every table name is prefixed p_balance_triggers_ by the helper
const t = defineTables(manifest)

export const triggerEvents = t.table('events', {
	id: D.integer('id').primaryKey({ autoIncrement: true }),
	triggerId: D.text('triggerId').notNull(),
	triggerVersion: D.integer('triggerVersion').notNull(),
	matchTriggeredId: D.integer('matchTriggeredId'),
	strongerTeam: D.text('strongerTeam', { enum: ['teamA', 'teamB'] }).notNull(),
	level: D.text('level', { enum: ['info', 'warn', 'violation'] }).notNull(),
	// the slice of history the trigger fired on, for the UI to explain itself
	input: D.text('input', { mode: 'json' }).notNull(),
	time: D.integer('time', { mode: 'timestamp_ms' }).notNull(),
})

export type TriggerEvent = typeof triggerEvents.$inferSelect
