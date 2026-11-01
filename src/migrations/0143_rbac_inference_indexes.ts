import type { MigrationDriver } from '@/server/migrate'

// Indexes the lookups rbac runs to infer a user's filter and rotation roles: ownership, and contribution by user or
// role. Each contributor table's primary key leads with the filter or rotation, so it serves none of them.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`CREATE INDEX filtersOwnerUserIdIndex ON filters (ownerUserId)`)
	db.exec(`CREATE INDEX rotationsOwnerUserIdIndex ON rotations (ownerUserId)`)
	db.exec(`CREATE INDEX filterUserContributorsUserIdIndex ON filterUserContributors (userId)`)
	db.exec(`CREATE INDEX rotationUserContributorsUserIdIndex ON rotationUserContributors (userId)`)
	db.exec(`CREATE INDEX filterRoleContributorsRoleIdIndex ON filterRoleContributors (roleId)`)
	db.exec(`CREATE INDEX rotationRoleContributorsRoleIdIndex ON rotationRoleContributors (roleId)`)
}
