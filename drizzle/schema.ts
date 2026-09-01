import { blob, customType, index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import superjson from 'superjson'

import * as ZodUtils from '@/lib/zod-utils'

import { APP_EVENT_ACTOR_TYPE, APP_EVENT_TYPE, SERVER_EVENT_PLAYER_ASSOC_TYPE, SERVER_EVENT_TYPE } from './enums'

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
		serverId: text('serverId')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
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

		// layerId parsed into its parts, so a layer-config query over history is an index walk instead of a
		// per-row call into the layer engine (which analytics exports and raw SQL readers don't have anyway).
		// All null for a layer the engine can't parse -- a RAW: id, or one retired from the engine artifact;
		// see reconcileRawLayerIds, which fills them in when a later artifact recognises the id.
		layerMap: text('layerMap'),
		layerGamemode: text('layerGamemode'),
		layerVersion: text('layerVersion'),
		layerTeam1Faction: text('layerTeam1Faction'),
		layerTeam1Unit: text('layerTeam1Unit'),
		layerTeam2Faction: text('layerTeam2Faction'),
		layerTeam2Unit: text('layerTeam2Unit'),
		setByType: text('setByType', {
			enum: ['manual', 'gameserver', 'generated', 'unknown', 'ingame-vote', 'plugin'],
		}).notNull(),
		setByUserId: bigintText('setByUserId'),
		// which plugin, when setByType is 'plugin'. Kept even after that plugin is uninstalled, so an old
		// match still says what queued it.
		setByPluginId: text('setByPluginId'),
	},
	(table) => ({
		layerIdIndex: index('layerIdIndex').on(table.layerId),
		startTimeIndex: index('startTimeIndex').on(table.startTime),
		endTimeIndex: index('endTimeIndex').on(table.endTime),
		userIndex: index('userIndex').on(table.setByUserId),
		serverOrdinalUnique: unique('serverOrdinalUnique').on(table.serverId, table.ordinal),
		layerPartsIndex: index('matchHistoryLayerPartsIndex').on(table.layerMap, table.layerGamemode),
	}),
)

export const serverEvents = sqliteTable(
	'serverEvents',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		type: text('type', { enum: ZodUtils.enumTupleOptions(SERVER_EVENT_TYPE) }).notNull(),
		time: timestamp('time').notNull(),
		matchId: integer('matchId')
			.references(() => matchHistory.id, { onDelete: 'cascade' })
			.notNull(),
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
		type: text('type', { enum: ZodUtils.enumTupleOptions(APP_EVENT_TYPE) }).notNull(),
		time: timestamp('time').notNull(),
		// actor, flattened for querying ("all actions by user X / player Y")
		actorType: text('actorType', { enum: ZodUtils.enumTupleOptions(APP_EVENT_ACTOR_TYPE) }).notNull(),
		actorUserId: bigintText('actorUserId'),
		actorPlayerId: text('actorPlayerId'),
		actorPluginId: text('actorPluginId'),
		// scope: null for global (audit-only) actions
		serverId: text('serverId').references(() => servers.id, { onDelete: 'cascade' }),
		matchId: integer('matchId').references(() => matchHistory.id, { onDelete: 'cascade' }),
		// provenance chain parent; app-level FK, not enforced at the DB
		causeId: text('causeId'),
		// the SLM process (otel service.instance.id) that emitted this event
		instanceId: text('instanceId'),
		// queryable projection of AppEvents.isFeedVisible: whether this event is worth a feed line at all, as
		// against being audit-log-only. The history page searches events the feed draws, so it filters on this
		// rather than re-deriving the predicate per row. Null on rows recorded before the backfill ran.
		feedVisible: boolean('feedVisible'),
		version: integer('version').default(1),
		data: json('data').notNull(),
	},
	(table) => ({
		appEventTypeIndex: index('appEventTypeIndex').on(table.type),
		appEventFeedVisibleIndex: index('appEventFeedVisibleIndex').on(table.feedVisible, table.time),
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

// active-kick timeouts. A row is active while cancelled=false and expiresAt > now; enforced globally on
// every SLM-managed server (players with an active timeout are kicked on connect / roster reset).
export const timeouts = sqliteTable(
	'timeouts',
	{
		id: text('id').primaryKey(),
		playerId: text('playerId')
			.notNull()
			.references(() => players.eosId, { onDelete: 'cascade' }),
		expiresAt: timestamp('expiresAt').notNull(),
		cancelled: boolean('cancelled').notNull().default(false),
		createdAt: timestamp('createdAt')
			.$defaultFn(() => new Date())
			.notNull(),
		// the PLAYER_TIMED_OUT app event recorded at creation; enforcement kicks attribute to it
		appEventId: text('appEventId').references(() => appEvents.id, { onDelete: 'set null' }),
		issuedServerId: text('issuedServerId').references(() => servers.id, { onDelete: 'set null' }),
		reasonLabel: text('reasonLabel'),
		// the unrendered reason text plus the variable values snapshotted at kick time (see AAR.AppliedReason).
		// rendered on demand: with the original duration for display, with the REMAINING duration for reconnect kicks.
		reasonTemplate: text('reasonTemplate'),
		reasonVars: json('reasonVars'),
	},
	(table) => ({
		timeoutsPlayerActiveIndex: index('timeoutsPlayerActiveIndex').on(table.playerId, table.cancelled, table.expiresAt),
		timeoutsExpiresAtIndex: index('timeoutsExpiresAtIndex').on(table.expiresAt),
	}),
)

// The permanent, long-horizon index over server events, keyed by the player each one is about. Distinct from
// serverEvents in two ways that matter: it carries no FK to that table, and it holds the dimensions a search
// filters on (time, match, server, type) rather than a payload. That is what lets it outlive compaction -- a
// match whose events have been packed into archivedMatches still answers "what did this player do", and the
// event bodies are fetched from the archive only for the page actually being shown.
//
// WITHOUT ROWID, with the pk ordered for the query that dominates: one player's history, newest first. The
// pk IS the table, so a player's whole trail is one contiguous range rather than an index scan plus a lookup.
export const playerEventIndex = sqliteTable(
	'playerEventIndex',
	{
		playerId: text('playerId')
			.notNull()
			.references(() => players.eosId, { onDelete: 'cascade' }),
		time: timestamp('time').notNull(),
		// serverEvents.id. Deliberately not a reference: compaction deletes the row this points at, and the
		// index entry has to survive that. Resolve event bodies through the match archive, not by joining here.
		serverEventId: integer('serverEventId').notNull(),
		assocType: text('assocType', { enum: ZodUtils.enumTupleOptions(SERVER_EVENT_PLAYER_ASSOC_TYPE) }).notNull(),
		matchId: integer('matchId')
			.notNull()
			.references(() => matchHistory.id, { onDelete: 'cascade' }),
		serverId: text('serverId')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		type: text('type', { enum: ZodUtils.enumTupleOptions(SERVER_EVENT_TYPE) }).notNull(),
		// The `caused by` token from the Die()/Wound() log line, for the events that carry one. NOT a weapon in
		// both cases, which is why it is not called one: on a Wound() the weapon actor is still alive and the
		// token is the weapon (BP_M240_M145), but by Die() it has usually been destroyed and what is left is the
		// attacker's pawn (BP_Soldier_TLF_Gendarme_01, BP_Loach_CAS_Small). Measured on production: of 782
		// distinct death tokens and 1161 wound tokens only 684 overlap. So group by this on PLAYER_WOUNDED for
		// weapon breakdowns and on PLAYER_DIED for what the killer was running -- never across both at once.
		//
		// Interned rather than stored inline: the token averages ~20 bytes and combat is the bulk of this table,
		// which over a five-year horizon is ~1GB of repeated strings against ~150MB of integers.
		damageSourceId: integer('damageSourceId').references(() => damageSources.id),
		// 'normal' | 'suicide' | 'teamkill'. Three values, so not worth interning, and a dashboard filtering on
		// `variant = 'teamkill'` should not have to join to find out what a number means.
		variant: text('variant'),
	},
	// Deliberately no secondary index on matchId. Every search here is anchored on a player, so the pk already
	// narrows to one contiguous range and a match filter is applied within it; the only matchId-driven query is
	// retention, which deletes a whole server's stale set in one statement and can afford the scan. On a
	// WITHOUT ROWID table a secondary index carries the entire pk, so that one index measured 26MB against the
	// table's own 42MB on the largest install -- more than a third of the cost, for nothing.
	(table) => ({
		pk: primaryKey({ columns: [table.playerId, table.time, table.serverEventId, table.assocType] }),
	}),
)

// What an app event is about, one row per value: the players it names, the layers it names. Generic over the
// dimension rather than a table per kind, because both have the same query shape and the write path is one walk
// over the event's meta (see event-meta.models.ts) -- a third dimension is an extractor and a new `dimension`
// value rather than another migration.
//
// The asymmetry with playerEventIndex is deliberate and is about size: that table carries millions of rows and
// earns a dedicated, tuned shape, where every app event ever recorded is a few thousand.
export const appEventAssociations = sqliteTable(
	'appEventAssociations',
	{
		// 'player' | 'layer'
		dimension: text('dimension').notNull(),
		// an eos id or a layer id, per the dimension
		value: text('value').notNull(),
		// denormalized from appEvents so one subject's trail is a contiguous pk range rather than a join then a sort
		time: timestamp('time').notNull(),
		appEventId: text('appEventId')
			.notNull()
			.references(() => appEvents.id, { onDelete: 'cascade' }),
		// how the event relates to the value: a ServerEventPlayerAssocType, or an EM.LayerAssocKind
		role: text('role').notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.dimension, table.value, table.time, table.appEventId, table.role] }),
		appEventAssociationsEventIdIndex: index('appEventAssociationsEventIdIndex').on(table.appEventId),
	}),
)

// The blueprint names playerEventIndex.damageSourceId points at, interned. Small and append-only: an install
// sees a couple of thousand distinct names, and one is never rewritten once seen.
export const damageSources = sqliteTable('damageSources', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
})

// A finalized match's server events, packed into one row once the match falls outside the recent window.
// The blob is the source of truth for that match from then on: every projection and export is rebuildable
// from it, which is what makes it safe to add a new search dimension years later.
export const archivedMatches = sqliteTable(
	'archivedMatches',
	{
		matchId: integer('matchId')
			.primaryKey()
			.references(() => matchHistory.id, { onDelete: 'cascade' }),
		serverId: text('serverId')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		eventCount: integer('eventCount').notNull(),
		// the id range packed inside `events`, so an id-bounded query can prune at match granularity without
		// unpacking. Null on rows packed before the columns existed.
		minEventId: integer('minEventId'),
		maxEventId: integer('maxEventId'),
		// how `events` is encoded, so a later codec can be introduced without rewriting what is already packed
		encoding: text('encoding').notNull(),
		events: blob('events').notNull(),
		createdAt: timestamp('createdAt')
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => ({
		serverIdIndex: index('archivedMatchesServerIdIndex').on(table.serverId),
	}),
)

// The two fts5 indexes, declared for reference only.
//
// Their DDL lives in the migrations (0106, 0108) because drizzle cannot express a virtual table, and neither is
// ever read through the query builder -- an fts5 search is a MATCH, which only the sql template can say. They
// are here so a query naming one names these objects rather than a bare string, which is what makes every use
// of a table or column findable.
export const chatSearch = sqliteTable('chatSearch', {
	message: text('message').notNull(),
	serverEventId: integer('serverEventId').notNull(),
	playerId: text('playerId').notNull(),
	matchId: integer('matchId').notNull(),
	serverId: text('serverId').notNull(),
	time: timestamp('time').notNull(),
})

export const usernameSearch = sqliteTable('usernameSearch', {
	username: text('username').notNull(),
	usernameNoTag: text('usernameNoTag').notNull(),
	eosId: text('eosId').notNull(),
})

// A history query a user chose to keep: the page's whole query state as one json value, so loading one is
// just writing it back into the url. 'shared' rows are visible to every user; `retain` marks an events query
// as a retention rule (see retainedEvents).
export const savedQueries = sqliteTable(
	'savedQueries',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		ownerId: bigintText('ownerId')
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
		visibility: text('visibility', { enum: ['private', 'shared'] })
			.notNull()
			.default('private'),
		retain: boolean('retain').notNull().default(false),
		query: json('query').notNull(),
		createdAt: timestamp('createdAt')
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: timestamp('updatedAt')
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => ({
		savedQueriesOwnerIndex: index('savedQueriesOwnerIndex').on(table.ownerId),
	}),
)

// Events kept past the retention period because a retention rule matched them, sieved out of a match as it
// is pruned. Rows mirror serverEvents so a reader can treat them as the rows they once were. matchHistory
// rows are never pruned, so the FK holds.
export const retainedEvents = sqliteTable(
	'retainedEvents',
	{
		serverEventId: integer('serverEventId').primaryKey(),
		type: text('type', { enum: ZodUtils.enumTupleOptions(SERVER_EVENT_TYPE) }).notNull(),
		time: timestamp('time').notNull(),
		matchId: integer('matchId')
			.notNull()
			.references(() => matchHistory.id, { onDelete: 'cascade' }),
		serverId: text('serverId')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		appEventId: text('appEventId'),
		version: integer('version'),
		data: json('data').notNull(),
	},
	(table) => ({
		retainedEventsMatchIdIndex: index('retainedEventsMatchIdIndex').on(table.matchId),
	}),
)

// Which retention rule keeps which event. An event may be claimed by several rules, and it is only dropped
// when its last claim goes.
export const retainedEventClaims = sqliteTable(
	'retainedEventClaims',
	{
		savedQueryId: text('savedQueryId')
			.notNull()
			.references(() => savedQueries.id, { onDelete: 'cascade' }),
		serverEventId: integer('serverEventId')
			.notNull()
			.references(() => retainedEvents.serverEventId, { onDelete: 'cascade' }),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.savedQueryId, table.serverEventId] }),
		retainedEventClaimsEventIndex: index('retainedEventClaimsEventIndex').on(table.serverEventId),
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
		// the match the squad existed in. Recorded here rather than reached through the events that reference it:
		// those events are deleted when the match is compacted, and a squad still has to name its match afterwards.
		matchId: integer('matchId').references(() => matchHistory.id, { onDelete: 'cascade' }),
		createdAt: timestamp('createdAt').$defaultFn(() => new Date()),
	},
	(table) => ({
		nameIndex: index('nameIndex').on(table.name),
		creatorIdIndex: index('creatorIdIndex').on(table.creatorId),
		squadMatchIdIndex: index('squadMatchIdIndex').on(table.matchId),
	}),
)

export const squadEventAssociations = sqliteTable(
	'squadEventAssociations',
	{
		serverEventId: integer('serverEventId')
			.references(() => serverEvents.id, { onDelete: 'cascade' })
			.notNull(),
		squadId: integer('squadId')
			.references(() => squads.id, { onDelete: 'cascade' })
			.notNull(),
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
	owner: bigintText('owner').references(() => users.discordId, { onDelete: 'set null' }),
	alertMessage: text('alertMessage'),
	// either a unicode emoji or a custom emoji (prefix discord_)
	emoji: text('emoji'),
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
	teamswaps: json('teamswaps').notNull().default(superjson.serialize(new Map())),
	backburner: json('backburner').notNull().default(superjson.serialize([])),
	switchRequests: json('switchRequests').default(superjson.serialize(null)),
	settings: json('settings').default(superjson.serialize({})),
	// 'scoped' entries are visible and usable only to their owner (ownerDiscordId); tutorials spin up per-user
	// emulated servers this way. 'public' (the default) is every server that existed before this column.
	visibility: text('visibility').notNull().default('public'),
	ownerDiscordId: bigintText('ownerDiscordId'),
})

export const globalSettings = sqliteTable('globalSettings', {
	id: integer('id').primaryKey().default(1),
	settings: json('settings').notNull().default(superjson.serialize({})),
})

// installed-plugin state: whether it should run, and its config (encoded z.input shape, like globalSettings).
// The tables a plugin owns are its own business (p_<id>_*, see src/models/plugins.models.ts).
export const plugins = sqliteTable('plugins', {
	id: text('id').primaryKey(),
	enabled: boolean('enabled').notNull().default(false),
	config: json('config').notNull().default(superjson.serialize({})),
})

export type Server = typeof servers.$inferSelect

// Every discord account SLM has had reason to record, whether or not it belongs to an SLM user. Steam accounts can
// be linked to a player who has never signed in, so the identity a link points at cannot be an SLM user row.
export const discordAccounts = sqliteTable('discordAccounts', {
	discordId: bigintText('discordId').notNull().primaryKey(),
	// https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names#h_01GXPQAGG6W477HSC5SR053QG1
	username: text('username').notNull(),
	updatedAt: timestamp('updatedAt')
		.$defaultFn(() => new Date())
		.notNull(),
})

export type DiscordAccount = typeof discordAccounts.$inferSelect

// A discord account that has signed into SLM. The row is what every ownership and actor reference means by "a user",
// so it stays distinct from the account itself: recording somebody's identity must not grant them one.
export const users = sqliteTable('users', {
	discordId: bigintText('discordId')
		.notNull()
		.primaryKey()
		.references(() => discordAccounts.discordId, { onDelete: 'cascade' }),
	// SLM-local display override the user sets for themselves, unlike `username`, which mirrors discord
	nickname: text('nickname'),
})

export type User = typeof users.$inferSelect

// How a steam link came to exist. 'self-serve' is the owner linking their own account; 'assigned' is another SLM
// user linking it on their behalf, which is the only case with an actor worth recording.
export const LINK_ORIGINS = ['self-serve', 'assigned'] as const
export type LinkOrigin = (typeof LINK_ORIGINS)[number]

// steam accounts linked to a discord account. steam64Id is the pk (globally unique), so a steam account belongs to
// at most one discord account. Deliberately no FK to `players`: admins may link accounts not present on any server.
export const linkedSteamAccounts = sqliteTable(
	'linkedSteamAccounts',
	{
		steam64Id: bigintText('steam64Id').primaryKey(),
		discordId: bigintText('discordId')
			.notNull()
			.references(() => discordAccounts.discordId, { onDelete: 'cascade' }),
		origin: text('origin', { enum: LINK_ORIGINS }).notNull(),
		// who assigned it, null for a self-serve link and for an assigner whose user row has since gone. Kept
		// alongside `origin` rather than inferred from it, so losing the actor never turns an assignment into a
		// self-serve link.
		linkedBy: bigintText('linkedBy').references(() => users.discordId, { onDelete: 'set null' }),
		createdAt: timestamp('createdAt')
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => ({
		linkedSteamDiscordIdIndex: index('linkedSteamDiscordIdIndex').on(table.discordId),
	}),
)

export type LinkedSteamAccount = typeof linkedSteamAccounts.$inferSelect

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

export const persistedCache = sqliteTable(
	'persistedCache',
	{
		key: text('key').primaryKey(),
		value: json('value').notNull(),
		updatedAt: timestamp('updatedAt')
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => ({
		updatedAtIndex: index('persistedCacheUpdatedAtIndex').on(table.updatedAt),
	}),
)

// Where a user is in each tutorial. Per user rather than per browser, so a run can be picked up later or from
// another machine. stepId is the step's own id, not its index: the step list is built per run from what the
// install supports, so an index means something different elsewhere. Null stepId with a completedAt is a finished
// tutorial; both null is one that was started and abandoned at the very beginning.
// A page's tutorial prompt, once the user has told it to stop. A row exists only for a dismissal, so the absence
// of one is the default.
export const tutorialPromptDismissals = sqliteTable(
	'tutorialPromptDismissals',
	{
		userId: bigintText('userId')
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
		surfaceId: text('surfaceId').notNull(),
		dismissedAt: timestamp('dismissedAt')
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.surfaceId] }),
	}),
)

export const tutorialProgress = sqliteTable(
	'tutorialProgress',
	{
		userId: bigintText('userId')
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
		scenarioId: text('scenarioId').notNull(),
		stepId: text('stepId'),
		completedAt: timestamp('completedAt'),
		updatedAt: timestamp('updatedAt')
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.scenarioId] }),
	}),
)
