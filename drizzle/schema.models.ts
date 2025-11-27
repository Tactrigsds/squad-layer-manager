import type * as Schema from '$root/drizzle/schema.ts'

export * from './enums'

export type Filter = typeof Schema.filters.$inferSelect
export type NewFilter = typeof Schema.filters.$inferInsert
export type Server = typeof Schema.servers.$inferInsert
export type Session = typeof Schema.sessions.$inferSelect
export type NewSession = typeof Schema.sessions.$inferInsert
export type User = typeof Schema.users.$inferSelect
export type NewUser = typeof Schema.users.$inferInsert
export type FilterUserContributor = typeof Schema.filterUserContributors.$inferSelect
export type NewFilterUserContributor = typeof Schema.filterUserContributors.$inferInsert
export type FilterRoleContributor = typeof Schema.filterRoleContributors.$inferSelect
export type NewFilterRoleContributor = typeof Schema.filterRoleContributors.$inferInsert
export type NewServer = typeof Schema.servers.$inferInsert
export type MatchHistory = typeof Schema.matchHistory.$inferSelect
export type NewMatchHistory = typeof Schema.matchHistory.$inferInsert
export type BalanceTriggerEvent = typeof Schema.balanceTriggerEvents.$inferSelect
export type NewBalanceTriggerEvent = typeof Schema.balanceTriggerEvents.$inferInsert
export type ServerEvent = typeof Schema.serverEvents.$inferSelect
export type NewServerEvent = typeof Schema.serverEvents.$inferInsert
