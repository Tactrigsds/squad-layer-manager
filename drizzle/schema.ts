import { enumTupleOptions } from '@/lib/zod'
import { bigint, index, int, json, mysqlEnum, mysqlTable, primaryKey, timestamp, unique, varchar } from 'drizzle-orm/mysql-core'
import superjson from 'superjson'
import { BALANCE_TRIGGER_LEVEL, SERVER_EVENT_PLAYER_ASSOC_TYPE, SERVER_EVENT_TYPE } from './enums'

export const matchHistory = mysqlTable(
	'matchHistory',
	{
		id: int('id').primaryKey().autoincrement(),
		serverId: varchar('serverId', { length: 256 }).notNull().references(() => servers.id, { onDelete: 'no action' }),
		ordinal: int('ordinal').notNull(),

		// may not be in layerId table (RAW: prefix or outdated)
		layerId: varchar('layerId', { length: 256 }).notNull(),

		// here for forwards compatibility & easy export to other systems
		rawLayerCommandText: varchar('rawLayerCommandText', { length: 256 }),
		lqItemId: varchar('lqItemId', { length: 256 }),
		startTime: timestamp('startTime'),
		endTime: timestamp('endTime'),
		createdAt: timestamp('createdAt').defaultNow(),
		outcome: mysqlEnum('outcome', ['team1', 'team2', 'draw']),

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
		serverOrdinalUnique: unique('serverOrdinalUnique').on(table.serverId, table.ordinal),
	}),
)

export const balanceTriggerEvents = mysqlTable(
	'balanceTriggerEvents',
	{
		id: int('id').primaryKey().autoincrement(),
		triggerId: varchar('triggerId', { length: 64 }).notNull(),
		triggerVersion: int('triggerVersion').notNull(),
		matchTriggeredId: int('matchTriggeredId').references(() => matchHistory.id, { onDelete: 'cascade' }),
		// the generic form of the message
		strongerTeam: mysqlEnum('strongerTeam', ['teamA', 'teamB']).notNull(),
		level: mysqlEnum(enumTupleOptions(BALANCE_TRIGGER_LEVEL)).notNull(),
		evaluationResult: json('evaluationResult').notNull(),
	},
)

export const serverEvents = mysqlTable(
	'serverEvents',
	{
		id: int('id').primaryKey().autoincrement(),
		type: mysqlEnum('type', enumTupleOptions(SERVER_EVENT_TYPE)).notNull(),
		time: timestamp('time').notNull(),
		matchId: int('matchId').references(() => matchHistory.id, { onDelete: 'cascade' }).notNull(),
		// TODO right now code just assumes one version, this is here for forwards compatibility
		version: int('version').default(1),
		data: json('data').notNull(),
	},
	(table) => ({
		typeIndex: index('typeIndex').on(table.type),
		timeIndex: index('timeIndex').on(table.time),
		matchIdIndex: index('matchIdIndex').on(table.matchId),
	}),
)

export const players = mysqlTable(
	'players',
	{
		steamId: bigint('steamId', { mode: 'bigint' }).primaryKey(),
		eosId: varchar('eosId', { length: 32 }).notNull().unique(),
		// exists for cases where we don't know wwhat the tag string is
		username: varchar('username', { length: 48 }).notNull(),
		usernameNoTag: varchar('usernameNoTag', { length: 32 }),
		createdAt: timestamp('createdAt').defaultNow(),
		modifiedAt: timestamp('modifiedAt').defaultNow(),
	},
	(table) => ({
		eosIdIndex: index('eosIdIndex').on(table.eosId),
		usernameIndex: index('usernameIndex').on(table.username),
		createdAtIndex: index('createdAtIndex').on(table.createdAt),
	}),
)

export const playerEventAssociations = mysqlTable(
	'playerEventAssociations',
	{
		serverEventId: int('serverEventId').references(() => serverEvents.id, { onDelete: 'cascade' }).notNull(),
		playerId: bigint('playerId', { mode: 'bigint' }).references(() => players.steamId, { onDelete: 'cascade' }).notNull(),
		assocType: mysqlEnum('assocType', enumTupleOptions(SERVER_EVENT_PLAYER_ASSOC_TYPE)).notNull(),
		createdAt: timestamp('createdAt').defaultNow(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.serverEventId, table.playerId] }),
		playerIdIndex: index('playerIdIndex').on(table.playerId),
	}),
)

export const squads = mysqlTable(
	'squads',
	{
		id: int('id').primaryKey(),
		ingameSquadId: int('ingameSquadId').notNull(),
		name: varchar('name', { length: 64 }).notNull(),
		creatorId: bigint('creatorId', { mode: 'bigint' }).references(() => players.steamId, { onDelete: 'set null' }),
		createdAt: timestamp('createdAt').defaultNow(),
	},
	(table) => ({
		nameIndex: index('nameIndex').on(table.name),
		creatorIdIndex: index('creatorIdIndex').on(table.creatorId),
	}),
)

export const squadEventAssociations = mysqlTable(
	'squadEventAssociations',
	{
		serverEventId: int('serverEventId').references(() => serverEvents.id, { onDelete: 'cascade' }).notNull(),
		squadId: int('squadId').references(() => squads.id, { onDelete: 'cascade' }).notNull(),
		createdAt: timestamp('createdAt').defaultNow(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.serverEventId, table.squadId] }),
	}),
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
	alertMessage: varchar('alertMessage', { length: 280 }),
	// either a unicode emoji or a custom emoji (prefix discord_)
	emoji: varchar('emoji', { length: 64 }).unique(),
	invertedAlertMessage: varchar('invertedAlertMessage', { length: 280 }),
	// either a unicode emoji or a custom emoji (prefix discord_)
	invertedEmoji: varchar('invertedEmoji', { length: 64 }),
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
	displayName: varchar('displayName', { length: 256 }).notNull(),
	// should be incremented whenver layer queue is modified. used to make sure modifiers are up-to-date with the current state of the queue before submitting modifications
	layerQueueSeqId: int('layerQueueSeqId').notNull().default(0),
	layerQueue: json('layerQueue').notNull().default(superjson.stringify([])),
	settings: json('settings').default(superjson.stringify({})),
})

export type Server = typeof servers.$inferSelect

export const users = mysqlTable('users', {
	discordId: bigint('discordId', { mode: 'bigint', unsigned: true })
		.notNull()
		.primaryKey(),
	steam64Id: bigint('steam64Id', { mode: 'bigint', unsigned: true }),
	// https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names#h_01GXPQAGG6W477HSC5SR053QG1
	username: varchar('username', { length: 32 }).notNull(),
	nickname: varchar('nickname', { length: 64 }),
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
