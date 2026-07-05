import { enumTupleOptions } from '@/lib/zod'
import { customType, index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import superjson from 'superjson'
import { APP_EVENT_ACTOR_TYPE, APP_EVENT_TYPE, BALANCE_TRIGGER_LEVEL, SERVER_EVENT_PLAYER_ASSOC_TYPE, SERVER_EVENT_TYPE } from './enums'

// 64-bit ids (discord/steam) are stored as TEXT: sqlite INTEGER is signed 64-bit and better-sqlite3
// returns plain (lossy) JS numbers, so text keeps precision while preserving `bigint` app-facing types.
const bigintText = customType<{ data: bigint; driverData: string }>({
	dataType: () => 'text',
	toDriver: (value) => value.toString(),
	fromDriver: (value) => BigInt(value),
})

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })
const json = (name: string) => text(name, { mode: 'json' })
const boolean = (name: string) => integer(name, { mode: 'boolean' })

export const matchHistory = sqliteTable(
	'matchHistory',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		serverId: text('serverId').notNull().references(() => servers.id, { onDelete: 'cascade' }),
		ordinal: integer('ordinal').notNull(),

		// may not be in layerId table (RAW: prefix or outdated)
		layerId: text('layerId').notNull(),

		// here for forwards compatibility & easy export to other systems
		rawLayerCommandText: text('rawLayerCommandText'),
		lqItemId: text('lqItemId'),
		startTime: timestamp('startTime'),
		endTime: timestamp('endTime'),
		createdAt: timestamp('createdAt').$defaultFn(() => new Date()),
		outcome: text('outcome', { enum: ['team1', 'team2', 'draw'] }),

		team1Tickets: integer('team1Tickets'),
		team2Tickets: integer('team2Tickets'),
		setByType: text('setByType', {
			enum: [
				'manual',
				'gameserver',
				'generated',
				'unknown',
			],
		}).notNull(),
		setByUserId: bigintText('setByUserId'),
	},
	(table) => ({
		layerIdIndex: index('layerIdIndex').on(table.layerId),
		startTimeIndex: index('startTimeIndex').on(table.startTime),
		endTimeIndex: index('endTimeIndex').on(table.endTime),
		userIndex: index('userIndex').on(table.setByUserId),
		serverOrdinalUnique: unique('serverOrdinalUnique').on(table.serverId, table.ordinal),
	}),
)

export const balanceTriggerEvents = sqliteTable(
	'balanceTriggerEvents',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		triggerId: text('triggerId').notNull(),
		triggerVersion: integer('triggerVersion').notNull(),
		matchTriggeredId: integer('matchTriggeredId').references(() => matchHistory.id, { onDelete: 'cascade' }),
		// the generic form of the message
		strongerTeam: text('strongerTeam', { enum: ['teamA', 'teamB'] }).notNull(),
		level: text('level', { enum: enumTupleOptions(BALANCE_TRIGGER_LEVEL) }).notNull(),
		evaluationResult: json('evaluationResult').notNull(),
	},
)

export const serverEvents = sqliteTable(
	'serverEvents',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		type: text('type', { enum: enumTupleOptions(SERVER_EVENT_TYPE) }).notNull(),
		time: timestamp('time').notNull(),
		matchId: integer('matchId').references(() => matchHistory.id, { onDelete: 'cascade' }).notNull(),
		// links this server event to the SLM app (audit) event that caused it, if any. queryable projection
		// of the event's `source` when source.type === 'event'.
		appEventId: text('appEventId').references(() => appEvents.id, { onDelete: 'set null' }),
		// TODO right now code just assumes one version, this is here for forwards compatibility
		version: integer('version').default(1),
		data: json('data').notNull(),
	},
	(table) => ({
		typeIndex: index('typeIndex').on(table.type),
		timeIndex: index('timeIndex').on(table.time),
		matchIdIndex: index('matchIdIndex').on(table.matchId),
		appEventIdIndex: index('appEventIdIndex').on(table.appEventId),
	}),
)

// SLM's audit log. See src/models/app-events.models.ts.
export const appEvents = sqliteTable(
	'appEvents',
	{
		// synchronously-allocated string id (createAppEventId) -- referenced by serverEvents.appEventId
		id: text('id').primaryKey(),
		type: text('type', { enum: enumTupleOptions(APP_EVENT_TYPE) }).notNull(),
		time: timestamp('time').notNull(),
		// actor, flattened for querying ("all actions by user X / player Y")
		actorType: text('actorType', { enum: enumTupleOptions(APP_EVENT_ACTOR_TYPE) }).notNull(),
		actorUserId: bigintText('actorUserId'),
		actorPlayerId: text('actorPlayerId'),
		// scope: null for global (audit-only) actions
		serverId: text('serverId').references(() => servers.id, { onDelete: 'cascade' }),
		matchId: integer('matchId').references(() => matchHistory.id, { onDelete: 'cascade' }),
		// provenance chain parent; app-level FK, not enforced at the DB
		causeId: text('causeId'),
		version: integer('version').default(1),
		data: json('data').notNull(),
	},
	(table) => ({
		appEventTypeIndex: index('appEventTypeIndex').on(table.type),
		appEventTimeIndex: index('appEventTimeIndex').on(table.time),
		appEventServerIdIndex: index('appEventServerIdIndex').on(table.serverId),
		appEventMatchIdIndex: index('appEventMatchIdIndex').on(table.matchId),
		appEventActorUserIdIndex: index('appEventActorUserIdIndex').on(table.actorUserId),
	}),
)

export const players = sqliteTable(
	'players',
	{
		eosId: text('eosId').notNull().primaryKey(),
		steamId: bigintText('steamId').unique(),
		epicId: text('epicId').unique(),
		// exists for cases where we don't know wwhat the tag string is
		username: text('username').notNull(),
		usernameNoTag: text('usernameNoTag'),
		createdAt: timestamp('createdAt').$defaultFn(() => new Date()),
		modifiedAt: timestamp('modifiedAt').$defaultFn(() => new Date()),
	},
	(table) => ({
		eosIdIndex: index('eosIdIndex').on(table.eosId),
		usernameIndex: index('usernameIndex').on(table.username),
		createdAtIndex: index('createdAtIndex').on(table.createdAt),
	}),
)

export const playerEventAssociations = sqliteTable(
	'playerEventAssociations',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		serverEventId: integer('serverEventId').references(() => serverEvents.id, { onDelete: 'cascade' }).notNull(),
		playerId: text('playerId').references(() => players.eosId, { onDelete: 'cascade' }).notNull(),
		assocType: text('assocType', { enum: enumTupleOptions(SERVER_EVENT_PLAYER_ASSOC_TYPE) }).notNull(),
		createdAt: timestamp('createdAt').$defaultFn(() => new Date()),
	},
	(table) => ({
		playerIdIndex: index('playerIdIndex').on(table.playerId),
		assocTypeIndex: index('assocTypeIndex').on(table.assocType),
		serverEventIdIndex: index('serverEventIdIndex').on(table.serverEventId),
		serverEventPlayerAssocUnique: unique('serverEventPlayerAssocUnique').on(table.serverEventId, table.playerId, table.assocType),
	}),
)

export const squads = sqliteTable(
	'squads',
	{
		id: integer('id').primaryKey(),
		ingameSquadId: integer('ingameSquadId').notNull(),
		teamId: integer('teamId').notNull(),
		name: text('name').notNull(),
		creatorId: text('creatorId').references(() => players.eosId, { onDelete: 'set null' }),
		createdAt: timestamp('createdAt').$defaultFn(() => new Date()),
	},
	(table) => ({
		nameIndex: index('nameIndex').on(table.name),
		creatorIdIndex: index('creatorIdIndex').on(table.creatorId),
	}),
)

export const squadEventAssociations = sqliteTable(
	'squadEventAssociations',
	{
		serverEventId: integer('serverEventId').references(() => serverEvents.id, { onDelete: 'cascade' }).notNull(),
		squadId: integer('squadId').references(() => squads.id, { onDelete: 'cascade' }).notNull(),
		createdAt: timestamp('createdAt').$defaultFn(() => new Date()),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.serverEventId, table.squadId] }),
		squadIdIndex: index('squadEventAssociationsSquadIdIndex').on(table.squadId),
	}),
)

export const filters = sqliteTable('filters', {
	id: text('id').primaryKey().notNull(),
	name: text('name').notNull(),
	description: text('description'),
	filter: json('filter').notNull(),
	owner: bigintText('owner').references(
		() => users.discordId,
		{ onDelete: 'set null' },
	),
	alertMessage: text('alertMessage'),
	// either a unicode emoji or a custom emoji (prefix discord_)
	emoji: text('emoji').unique(),
	invertedAlertMessage: text('invertedAlertMessage'),
	// either a unicode emoji or a custom emoji (prefix discord_)
	invertedEmoji: text('invertedEmoji'),
})

export const filterUserContributors = sqliteTable(
	'filterUserContributors',
	{
		filterId: text('filterId')
			.notNull()
			.references(() => filters.id, { onDelete: 'cascade' }),
		userId: bigintText('userId')
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.filterId, table.userId] }),
	}),
)

export const filterRoleContributors = sqliteTable(
	'filterRoleContributors',
	{
		filterId: text('filterId')
			.notNull()
			.references(() => filters.id, { onDelete: 'cascade' }),
		roleId: text('roleId').notNull(),
	},
	(table) => ({ pk: primaryKey({ columns: [table.filterId, table.roleId] }) }),
)

export type Filter = typeof filters.$inferSelect
export type NewFilter = typeof filters.$inferInsert

export const servers = sqliteTable('servers', {
	id: text('id').primaryKey(),
	displayName: text('displayName').notNull(),
	enabled: boolean('enabled').notNull().default(true),
	defaultServer: boolean('defaultServer').notNull().default(false),
	layerQueue: json('layerQueue').notNull().default(superjson.serialize([])),
	teamswitches: json('teamswitches').notNull().default(superjson.serialize(new Map())),
	settings: json('settings').default(superjson.serialize({})),
})

export const globalSettings = sqliteTable('globalSettings', {
	id: integer('id').primaryKey().default(1),
	settings: json('settings').notNull().default(superjson.serialize({})),
})

export type Server = typeof servers.$inferSelect

export const users = sqliteTable('users', {
	discordId: bigintText('discordId')
		.notNull()
		.primaryKey(),
	steam64Id: bigintText('steam64Id').unique(),
	// https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names#h_01GXPQAGG6W477HSC5SR053QG1
	username: text('username').notNull(),
	nickname: text('nickname'),
})

export type User = typeof users.$inferSelect

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('session').primaryKey(),
		userId: bigintText('userId')
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
		expiresAt: timestamp('expiresAt').notNull(),
	},
	(table) => ({
		expiresAtIndex: index('expiresAtIndex').on(table.expiresAt),
		userIdIndex: index('sessionUserIdIndex').on(table.userId),
	}),
)

export const persistedCache = sqliteTable('persistedCache', {
	key: text('key').primaryKey(),
	value: json('value').notNull(),
	updatedAt: timestamp('updatedAt').$defaultFn(() => new Date()).notNull(),
}, (table) => ({
	updatedAtIndex: index('persistedCacheUpdatedAtIndex').on(table.updatedAt),
}))
