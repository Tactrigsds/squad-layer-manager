import * as D from 'drizzle-orm/sqlite-core'

import { defineTables } from 'slm/plugin'

import manifest from './plugin.ts'

const t = defineTables(manifest)

export const greetings = t.table('greetings', {
	id: D.integer('id').primaryKey({ autoIncrement: true }),
	serverId: D.text('serverId').notNull(),
	text: D.text('text').notNull(),
	matches: D.integer('matches').notNull(),
})
