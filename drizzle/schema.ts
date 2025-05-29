import { bigint, boolean, float, index, int, json, mysqlEnum, mysqlTable, primaryKey, timestamp, varchar } from 'drizzle-orm/mysql-core'
import superjson from 'superjson'

export const layers = mysqlTable(
	'layers',
	{
		id: varchar('id', { length: 64 }).primaryKey().notNull(),

		Map: varchar('Map', { length: 255 }).notNull(),
		Layer: varchar('Layer', { length: 255 }).notNull(),
		Size: varchar('Size', { length: 255 }).notNull(),
		Gamemode: varchar('Gamemode', { length: 255 }).notNull(),
		LayerVersion: varchar('LayerVersion', { length: 255 }),

		Faction_1: varchar('Faction_1', { length: 255 }).notNull(),
		Unit_1: varchar('Unit_1', { length: 255 }).notNull(),
		Alliance_1: varchar('Alliance_1', { length: 255 }).notNull(),

		Faction_2: varchar('Faction_2', { length: 255 }).notNull(),
		Unit_2: varchar('Unit_2', { length: 255 }).notNull(),
		Alliance_2: varchar('Alliance_2', { length: 255 }).notNull(),

		Logistics_1: float('Logistics_1').default(NaN),
		Transportation_1: float('Transportation_1').default(NaN),
		'Anti-Infantry_1': float('Anti-Infantry_1').default(NaN),
		Armor_1: float('Armor_1').default(NaN),
		ZERO_Score_1: float('ZERO_Score_1').default(NaN),
		Logistics_2: float('Logistics_2').default(NaN),
		Transportation_2: float('Transportation_2').default(NaN),
		'Anti-Infantry_2': float('Anti-Infantry_2').default(NaN),
		Armor_2: float('Armor_2').default(NaN),
		ZERO_Score_2: float('ZERO_Score_2').default(NaN),
		Balance_Differential: float('Balance_Differential').default(NaN),
		Asymmetry_Score: float('Asymmetry_Score').default(NaN),
		Logistics_Diff: float('Logistics_Diff').default(NaN),
		Transportation_Diff: float('Transportation_Diff').default(NaN),
		'Anti-Infantry_Diff': float('Anti-Infantry_Diff').default(NaN),
		Armor_Diff: float('Armor_Diff').default(NaN),
		ZERO_Score_Diff: float('ZERO_Score_Diff').default(NaN),
		Z_Pool: boolean('Z_Pool').notNull().default(false),
		Scored: boolean('Scored').notNull().default(false),
	},
	(layers) => {
		return {
			mapIndex: index('mapIndex').on(layers.Map),
			layerIndex: index('layerIndex').on(layers.Layer),
			sizeIndex: index('sizeIndex').on(layers.Size),
			gamemodeIndex: index('gamemodeIndex').on(layers.Gamemode),
			layerVersionIndex: index('layerVersionIndex').on(layers.LayerVersion),
			faction1Index: index('faction1Index').on(layers.Faction_1),
			faction2Index: index('faction2Index').on(layers.Faction_2),
			unit1Index: index('unit1Index').on(layers.Unit_1),
			unit2Index: index('unit2Index').on(layers.Unit_2),
			alliance1Index: index('alliance1Index').on(layers.Alliance_1),
			alliance2Index: index('alliance2Index').on(layers.Alliance_2),
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
			balanceDifferentialIndex: index('balanceDifferentialIndex').on(
				layers.Balance_Differential,
			),
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

export const matchHistory = mysqlTable(
	'matchHistory',
	{
		id: int('id').primaryKey().autoincrement(),
		ordinal: int('ordinal').notNull().unique(),

		// may not be in layerId table (RAW: prefix or outdated)
		layerId: varchar('layerId', { length: 256 }).notNull(),
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

export const genLayerColumnOrder = mysqlTable('genLayerColumnOrder', {
	columnName: varchar('columnName', { length: 255 }).primaryKey().notNull(),
	ordinal: int('ordinal').notNull(),
})

export const genLayerWeights = mysqlTable(
	'genLayerWeights',
	{
		columnName: varchar('columnName', { length: 255 }).notNull(),
		value: varchar('value', { length: 255 }).notNull(),
		weight: float('weight').notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.columnName, table.value] }),
		columnNameIndex: index('columnNameIndex').on(table.columnName),
		valueIndex: index('valueIndex').on(table.value),
	}),
)
