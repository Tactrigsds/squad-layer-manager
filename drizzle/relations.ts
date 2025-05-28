import { relations } from 'drizzle-orm/relations'
import { filterRoleContributors, filters, filterUserContributors, sessions, users } from './schema'

export const filterRoleContributorsRelations = relations(filterRoleContributors, ({ one }) => ({
	filter: one(filters, {
		fields: [filterRoleContributors.filterId],
		references: [filters.id],
	}),
}))

export const filtersRelations = relations(filters, ({ one, many }) => ({
	filterRoleContributors: many(filterRoleContributors),
	filterUserContributors: many(filterUserContributors),
	user: one(users, {
		fields: [filters.owner],
		references: [users.discordId],
	}),
}))

export const filterUserContributorsRelations = relations(filterUserContributors, ({ one }) => ({
	filter: one(filters, {
		fields: [filterUserContributors.filterId],
		references: [filters.id],
	}),
	user: one(users, {
		fields: [filterUserContributors.userId],
		references: [users.discordId],
	}),
}))

export const usersRelations = relations(users, ({ many }) => ({
	filterUserContributors: many(filterUserContributors),
	filters: many(filters),
	sessions: many(sessions),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, {
		fields: [sessions.userId],
		references: [users.discordId],
	}),
}))
