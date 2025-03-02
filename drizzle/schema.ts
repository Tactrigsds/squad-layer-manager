import { bigint, boolean, float, index, int, json, mysqlTable, primaryKey, timestamp, unique, varchar } from 'drizzle-orm/mysql-core'
import superjson from 'superjson'

export const factions = mysqlTable(
	'factions',
	{
		shortName: varchar('shortName', { length: 255 }).primaryKey().notNull(),
		fullName: varchar('fullName', { length: 255 }).notNull(),
		alliance: varchar('alliance', { length: 255 }).notNull(),
	},
	(factions) => ({
		fullNameIndex: index('fullNameIndex').on(factions.fullName),
		allianceIndex: index('allianceIndex').on(factions.alliance),
	}),
)

export const subfactions = mysqlTable(
	'subfactions',
	{
		shortName: varchar('shortName', { length: 255 }).notNull(),
		factionShortName: varchar('factionShortName', { length: 255 })
			.notNull()
			.references(() => factions.shortName),
		fullName: varchar('fullName', { length: 255 }).notNull(),
	},
	(subfactions) => ({
		primaryKey: unique().on(subfactions.shortName, subfactions.factionShortName),
		fullName: index('fullName').on(subfactions.fullName),
		factionShortName: index('factionShortName').on(subfactions.factionShortName),
	}),
)

export const layers = mysqlTable(
	'layers',
	{
		id: varchar('id', { length: 64 }).primaryKey().notNull(),
		Level: varchar('Level', { length: 255 }).notNull(),
		Layer: varchar('Layer', { length: 255 }).notNull(),
		Size: varchar('Size', { length: 255 }).notNull(),
		Gamemode: varchar('Gamemode', { length: 255 }).notNull(),
		LayerVersion: varchar('LayerVersion', { length: 255 }),
		Faction_1: varchar('Faction_1', { length: 255 }).notNull(),
		SubFac_1: varchar('SubFac_1', { length: 255 }),
		Logistics_1: float('Logistics_1'),
		Transportation_1: float('Transportation_1'),
		'Anti-Infantry_1': float('Anti-Infantry_1'),
		Armor_1: float('Armor_1'),
		ZERO_Score_1: float('ZERO_Score_1'),
		Faction_2: varchar('Faction_2', { length: 255 }).notNull(),
		SubFac_2: varchar('SubFac_2', { length: 255 }),
		Logistics_2: float('Logistics_2'),
		Transportation_2: float('Transportation_2'),
		'Anti-Infantry_2': float('Anti-Infantry_2'),
		Armor_2: float('Armor_2'),
		ZERO_Score_2: float('ZERO_Score_2'),
		Balance_Differential: float('Balance_Differential'),
		Asymmetry_Score: float('Asymmetry_Score'),
		Logistics_Diff: float('Logistics_Diff'),
		Transportation_Diff: float('Transportation_Diff'),
		'Anti-Infantry_Diff': float('Anti-Infantry_Diff'),
		Armor_Diff: float('Armor_Diff'),
		ZERO_Score_Diff: float('ZERO_Score_Diff'),
		Z_Pool: boolean('Z_Pool').notNull().default(false),
		Scored: boolean('Scored').notNull().default(false),
	},
	(layers) => {
		return {
			levelIndex: index('levelIndex').on(layers.Level),
			layerIndex: index('layerIndex').on(layers.Layer),
			sizeIndex: index('sizeIndex').on(layers.Size),
			gamemodeIndex: index('gamemodeIndex').on(layers.Gamemode),
			layerVersionIndex: index('layerVersionIndex').on(layers.LayerVersion),
			faction1Index: index('faction1Index').on(layers.Faction_1),
			subfac1Index: index('subfac1Index').on(layers.SubFac_1),
			faction2Index: index('faction2Index').on(layers.Faction_2),
			subfac2Index: index('subfac2Index').on(layers.SubFac_2),
			logistics1Index: index('logistics1Index').on(layers.Logistics_1),
			transportation1Index: index('transportation1Index').on(layers.Transportation_1),
			antiInfantry1Index: index('antiInfantry1Index').on(layers['Anti-Infantry_1']),
			armor1Index: index('armor1Index').on(layers.Armor_1),
			zeroScore1Index: index('zeroScore1Index').on(layers.ZERO_Score_1),
			logistics2Index: index('logistics2Index').on(layers.Logistics_2),
			transportation2Index: index('transportation2Index').on(layers.Transportation_2),
			antiInfantry2Index: index('antiInfantry2Index').on(layers['Anti-Infantry_2']),
			armor2Index: index('armor2Index').on(layers.Armor_2),
			zeroScore2Index: index('zeroScore2Index').on(layers.ZERO_Score_2),
			balanceDifferentialIndex: index('balanceDifferentialIndex').on(layers.Balance_Differential),
			asymmetryScoreIndex: index('asymmetryScoreIndex').on(layers['Asymmetry_Score']),
			logisticsDiffIndex: index('logisticsDiffIndex').on(layers.Logistics_Diff),
			transportationDiffIndex: index('transportationDiffIndex').on(layers.Transportation_Diff),
			antiInfantryDiffIndex: index('antiInfantryDiffIndex').on(layers['Anti-Infantry_Diff']),
			armorDiffIndex: index('armorDiffIndex').on(layers.Armor_Diff),
			zeroScoreDiffIndex: index('zeroScoreDiffIndex').on(layers.ZERO_Score_Diff),
			Z_PoolIndex: index('Z_PoolIndex').on(layers.Z_Pool),
			Scored: index('ScoredIndex').on(layers.Scored),
		}
	},
)
export const filters = mysqlTable('filters', {
	id: varchar('id', { length: 64 }).primaryKey().notNull(),
	name: varchar('name', { length: 128 }).notNull(),
	description: varchar('description', { length: 2048 }),
	filter: json('filter').notNull(),
	owner: bigint('owner', { mode: 'bigint', unsigned: true }).references(() => users.discordId, { onDelete: 'set null' }),
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
	historyFilters: json('historyFilters').notNull().default(superjson.stringify([])),
	settings: json('settings').default(superjson.stringify({})),

	lastRoll: timestamp('lastRoll', { mode: 'date' }),
})

export type Server = typeof servers.$inferSelect

export const users = mysqlTable('users', {
	discordId: bigint('discordId', { mode: 'bigint', unsigned: true }).notNull().primaryKey(),
	// https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names#h_01GXPQAGG6W477HSC5SR053QG1
	username: varchar('username', { length: 32 }).notNull(),
	avatar: varchar('avatar', { length: 255 }),
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
