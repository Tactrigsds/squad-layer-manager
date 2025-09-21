import { bigint, boolean, float, index, int, json, mysqlEnum, mysqlTable, primaryKey, timestamp, varchar } from 'drizzle-orm/mysql-core'
import superjson from 'superjson'
import { z } from 'zod'

export const matchHistory = mysqlTable(
	'matchHistory',
	{
		id: int('id').primaryKey().autoincrement(),
		ordinal: int('ordinal').notNull().unique(),

		// may not be in layerId table (RAW: prefix or outdated)
		layerId: varchar('layerId', { length: 256 }).notNull(),

		// here for forwards compatibility & easy export to other systems
		rawLayerCommandText: varchar('rawLayerCommandText', { length: 256 }),
		lqItemId: varchar('lqItemId', { length: 256 }),
		startTime: timestamp('startTime'),
		endTime: timestamp('endTime'),
		outcome: mysqlEnum('outcome', ['team1', 'team2', 'draw']),
		layerVote: json('layerVote'),

		team1Tickets: int('team1Tickets'),
		team2Tickets: int('team2Tickets'),
		setByType: mysqlEnum('setByType', [
			'manual',
			'gameserver',
			'generated',
			'unknown',
		]).notNull(),
		setByUserId: bigint('setByUserId', { mode: 'bigint', unsigned: true }),
	},
	(table) => ({
		layerIdIndex: index('layerIdIndex').on(table.layerId),
		startTimeIndex: index('startTimeIndex').on(table.startTime),
		endTimeIndex: index('endTimeIndex').on(table.endTime),
		userIndex: index('userIndex').on(table.setByUserId),
	}),
)

export const TRIGGER_LEVEL = z.enum(['info', 'warn', 'violation'])
export const balanceTriggerEvents = mysqlTable(
	'balanceTriggerEvents',
	{
		id: int('id').primaryKey().autoincrement(),
		triggerId: varchar('triggerId', { length: 64 }).notNull(),
		triggerVersion: int('triggerVersion').notNull(),
		matchTriggeredId: int('matchTriggeredId').references(() => matchHistory.id, { onDelete: 'cascade' }),
		// the generic form of the message
		strongerTeam: mysqlEnum('strongerTeam', ['teamA', 'teamB']).notNull(),
		level: mysqlEnum(TRIGGER_LEVEL.options).notNull(),
		evaluationResult: json('evaluationResult').notNull(),
	},
)

export const filters = mysqlTable('filters', {
	id: varchar('id', { length: 64 }).primaryKey().notNull(),
	name: varchar('name', { length: 128 }).notNull(),
	description: varchar('description', { length: 2048 }),
	filter: json('filter').notNull(),
	owner: bigint('owner', { mode: 'bigint', unsigned: true }).references(
		() => users.discordId,
		{ onDelete: 'set null' },
	),
})

export const filterUserContributors = mysqlTable(
	'filterUserContributors',
	{
		filterId: varchar('filterId', { length: 64 })
			.notNull()
			.references(() => filters.id, { onDelete: 'cascade' }),
		userId: bigint('userId', { mode: 'bigint', unsigned: true })
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.filterId, table.userId] }),
	}),
)

export const filterRoleContributors = mysqlTable(
	'filterRoleContributors',
	{
		filterId: varchar('filterId', { length: 64 })
			.notNull()
			.references(() => filters.id, { onDelete: 'cascade' }),
		roleId: varchar('roleId', { length: 32 }).notNull(),
	},
	(table) => ({ pk: primaryKey({ columns: [table.filterId, table.roleId] }) }),
)

export type Filter = typeof filters.$inferSelect
export type NewFilter = typeof filters.$inferInsert

export const servers = mysqlTable('servers', {
	id: varchar('id', { length: 256 }).primaryKey(),
	online: boolean('online').notNull().default(false),
	displayName: varchar('displayName', { length: 256 }).notNull(),
	// should be incremented whenver layer queue is modified. used to make sure modifiers are up-to-date with the current state of the queue before submitting modifications
	layerQueueSeqId: int('layerQueueSeqId').notNull().default(0),
	layerQueue: json('layerQueue').notNull().default(superjson.stringify([])),
	settings: json('settings').default(superjson.stringify({})),
	lastRoll: timestamp('lastRoll', { mode: 'date' }),
})

export type Server = typeof servers.$inferSelect

export const users = mysqlTable('users', {
	discordId: bigint('discordId', { mode: 'bigint', unsigned: true })
		.notNull()
		.primaryKey(),
	// https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names#h_01GXPQAGG6W477HSC5SR053QG1
	username: varchar('username', { length: 32 }).notNull(),
	avatar: varchar('avatar', { length: 255 }),
})

export const steamAccounts = mysqlTable('steamAccounts', {
	discordId: bigint('discordId', { mode: 'bigint', unsigned: true })
		.notNull()
		.primaryKey().references(() => users.discordId, { onDelete: 'cascade' }),
	steam64Id: bigint('steam64Id', { mode: 'bigint', unsigned: true })
		.notNull()
		.primaryKey(),
	rowTimestamp: timestamp('rowTimestamp').notNull().defaultNow(),
})

export type User = typeof users.$inferSelect

export const sessions = mysqlTable(
	'sessions',
	{
		id: varchar('session', { length: 255 }).primaryKey(),
		userId: bigint('userId', { mode: 'bigint', unsigned: true })
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
		expiresAt: timestamp('expiresAt').notNull(),
	},
	(table) => ({
		expiresAtIndex: index('expiresAtIndex').on(table.expiresAt),
	}),
)
