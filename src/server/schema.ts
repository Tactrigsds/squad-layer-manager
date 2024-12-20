import { bigint, boolean, float, index, int, json, mysqlEnum, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core'
import superjson from 'superjson'

import { SUBFACTIONS } from '@/lib/constants'

export const factions = mysqlTable(
	'factions',
	{
		shortName: varchar('shortName', { length: 10 }).primaryKey().notNull(),
		fullName: varchar('fullName', { length: 255 }).notNull(),
	},
	(factions) => ({
		fullNameIndex: index('fullNameIndex').on(factions.fullName),
	})
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
		SubFac_1: mysqlEnum('SubFac_1', SUBFACTIONS),
		Logistics_1: float('Logistics_1').notNull(),
		Transportation_1: float('Transportation_1').notNull(),
		'Anti-Infantry_1': float('Anti-Infantry_1').notNull(),
		Armor_1: float('Armor_1').notNull(),
		ZERO_Score_1: float('ZERO_Score_1').notNull(),
		Faction_2: varchar('Faction_2', { length: 255 }).notNull(),
		SubFac_2: mysqlEnum('SubFac_2', SUBFACTIONS),
		Logistics_2: float('Logistics_2').notNull(),
		Transportation_2: float('Transportation_2').notNull(),
		'Anti-Infantry_2': float('Anti-Infantry_2').notNull(),
		Armor_2: float('Armor_2').notNull(),
		ZERO_Score_2: float('ZERO_Score_2').notNull(),
		Balance_Differential: float('Balance_Differential').notNull(),
		'Asymmetry Score': float('Asymmetry Score').notNull(),
		Logistics_Diff: float('Logistics_Diff').notNull(),
		Transportation_Diff: float('Transportation_Diff').notNull(),
		'Anti-Infantry_Diff': float('Anti-Infantry_Diff').notNull(),
		Armor_Diff: float('Armor_Diff').notNull(),
		ZERO_Score_Diff: float('ZERO_Score_Diff').notNull(),
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
			asymmetryScoreIndex: index('asymmetryScoreIndex').on(layers['Asymmetry Score']),
			logisticsDiffIndex: index('logisticsDiffIndex').on(layers.Logistics_Diff),
			transportationDiffIndex: index('transportationDiffIndex').on(layers.Transportation_Diff),
			antiInfantryDiffIndex: index('antiInfantryDiffIndex').on(layers['Anti-Infantry_Diff']),
			armorDiffIndex: index('armorDiffIndex').on(layers.Armor_Diff),
			zeroScoreDiffIndex: index('zeroScoreDiffIndex').on(layers.ZERO_Score_Diff),
		}
	}
)
export type Layer = typeof layers.$inferSelect
export const MINI_LAYER_SELECT = {
	id: layers.id,
	Level: layers.Level,
	Layer: layers.Layer,
	Gamemode: layers.Gamemode,
	LayerVersion: layers.LayerVersion,
	Faction_1: layers.Faction_1,
	SubFac_1: layers.SubFac_1,
	Faction_2: layers.Faction_2,
	SubFac_2: layers.SubFac_2,
}

export const filters = mysqlTable('filters', {
	id: varchar('id', { length: 64 }).primaryKey().notNull(),
	name: varchar('name', { length: 128 }).notNull(),
	description: varchar('description', { length: 512 }),
	filter: json('filter').notNull(),
})
export type Filter = typeof filters.$inferSelect

export const servers = mysqlTable('servers', {
	id: varchar('id', { length: 256 }).primaryKey(),
	online: boolean('online').notNull().default(false),
	displayName: varchar('displayName', { length: 256 }).notNull(),
	// should be incremented whenver layer queue is modified. used to make sure modifiers are up-to-date with the current state of the queue before submitting modifications
	layerQueueSeqId: int('layerQueueSeqId').notNull().default(0),
	layerQueue: json('layerQueue').notNull().default(superjson.stringify([])),
	currentVote: json('currentVote'),
	settings: json('settings').default(superjson.stringify({})),
})

export type Server = typeof servers.$inferSelect

export const users = mysqlTable('users', {
	discordId: bigint('discordId', { mode: 'bigint' }).notNull().primaryKey(),
	// https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names#h_01GXPQAGG6W477HSC5SR053QG1
	username: varchar('username', { length: 32 }).notNull(),
	avatar: varchar('avatar', { length: 255 }).notNull(),
})

export type User = typeof users.$inferSelect

export const sessions = mysqlTable(
	'sessions',
	{
		id: varchar('session', { length: 255 }).primaryKey(),
		userId: bigint('userId', { mode: 'bigint' })
			.notNull()
			.references(() => users.discordId, { onDelete: 'cascade' }),
		expiresAt: timestamp('expiresAt').notNull(),
	},
	(table) => ({
		expiresAtIndex: index('expiresAtIndex').on(table.expiresAt),
	})
)
