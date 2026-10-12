import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Rotations: saved, ordered lists of queue items, owned and contributed to the way filters are.
//
//   rotations                 (id, name, description, items, repeatRulesetId, tags, archived, owner, timestamps)
//   rotationUserContributors  (rotationId, userId)
//   rotationRoleContributors  (rotationId, roleId)
//
// A role that may create filters may now create rotations, and one that may edit every filter may edit every
// rotation: rotations:create and rotations:write-all are granted alongside filters:create and filters:write-all.
// A role that denies one outright keeps denying it. Idempotent.
const GRANTS: [string, string][] = [
	['filters:create', 'rotations:create'],
	['filters:write-all', 'rotations:write-all'],
]

export async function up(db: MigrationDriver): Promise<void> {
	grantRotationPermissions(db)
	db.exec(`
		CREATE TABLE IF NOT EXISTS \`rotations\` (
			\`id\` text PRIMARY KEY NOT NULL,
			\`name\` text NOT NULL,
			\`description\` text,
			\`items\` text NOT NULL,
			\`repeatRulesetId\` text,
			\`tags\` text NOT NULL,
			\`archived\` integer DEFAULT false NOT NULL,
			\`ownerUserId\` text,
			\`ownerPluginId\` text,
			\`createdAt\` integer NOT NULL,
			\`updatedAt\` integer NOT NULL,
			FOREIGN KEY (\`ownerUserId\`) REFERENCES \`users\`(\`discordId\`) ON UPDATE no action ON DELETE set null,
			FOREIGN KEY (\`ownerPluginId\`) REFERENCES \`plugins\`(\`id\`) ON UPDATE no action ON DELETE set null,
			CONSTRAINT \`rotationsSingleOwner\` CHECK(\`ownerUserId\` IS NULL OR \`ownerPluginId\` IS NULL)
		);
		CREATE TABLE IF NOT EXISTS \`rotationUserContributors\` (
			\`rotationId\` text NOT NULL,
			\`userId\` text NOT NULL,
			PRIMARY KEY(\`rotationId\`, \`userId\`),
			FOREIGN KEY (\`rotationId\`) REFERENCES \`rotations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
			FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`discordId\`) ON UPDATE no action ON DELETE cascade
		);
		CREATE TABLE IF NOT EXISTS \`rotationRoleContributors\` (
			\`rotationId\` text NOT NULL,
			\`roleId\` text NOT NULL,
			PRIMARY KEY(\`rotationId\`, \`roleId\`),
			FOREIGN KEY (\`rotationId\`) REFERENCES \`rotations\`(\`id\`) ON UPDATE no action ON DELETE cascade
		);
	`)
}

function grantRotationPermissions(db: MigrationDriver) {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return
	const settings = superjson.parse(row.settings) as { rbac?: { roles?: Record<string, { permissions?: unknown }> } }
	const roles = settings?.rbac?.roles
	if (!roles || typeof roles !== 'object') return

	let changed = false
	for (const cfg of Object.values(roles)) {
		if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.permissions)) continue
		const permissions = [...(cfg.permissions as unknown[])]
		for (const [filterPerm, rotationPerm] of GRANTS) {
			if (!permissions.includes(filterPerm)) continue
			if (permissions.includes(rotationPerm) || permissions.includes(`!${rotationPerm}`)) continue
			permissions.push(rotationPerm)
		}
		if (permissions.length === cfg.permissions.length) continue
		cfg.permissions = permissions
		changed = true
	}
	if (!changed) return
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(superjson.stringify(settings), row.id)
}
