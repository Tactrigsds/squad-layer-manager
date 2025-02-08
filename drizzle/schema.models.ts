import * as Schema from '$root/drizzle/schema.ts'
export type Layer = typeof Schema.layers.$inferSelect
export type Filter = typeof Schema.filters.$inferSelect
export type NewFilter = typeof Schema.filters.$inferInsert
export type Server = typeof Schema.servers.$inferInsert
export type Faction = typeof Schema.factions.$inferSelect
export type NewFaction = typeof Schema.factions.$inferInsert
export type Subfaction = typeof Schema.subfactions.$inferSelect
export type NewSubfaction = typeof Schema.subfactions.$inferInsert
export type Session = typeof Schema.sessions.$inferSelect
export type NewSession = typeof Schema.sessions.$inferInsert
export type User = typeof Schema.users.$inferSelect
export type NewUser = typeof Schema.users.$inferInsert
export type FilterUserContributor = typeof Schema.filterUserContributors.$inferSelect
export type NewFilterUserContributor = typeof Schema.filterUserContributors.$inferInsert
export type FilterRoleContributor = typeof Schema.filterRoleContributors.$inferSelect
export type NewFilterRoleContributor = typeof Schema.filterRoleContributors.$inferInsert
export type NewServer = typeof Schema.servers.$inferInsert

export const MINI_LAYER_SELECT = {
	id: Schema.layers.id,
	Level: Schema.layers.Level,
	Layer: Schema.layers.Layer,
	Gamemode: Schema.layers.Gamemode,
	LayerVersion: Schema.layers.LayerVersion,
	Faction_1: Schema.layers.Faction_1,
	SubFac_1: Schema.layers.SubFac_1,
	Faction_2: Schema.layers.Faction_2,
	SubFac_2: Schema.layers.SubFac_2,
}
