import type { MigrationDriver } from '@/server/migrate'

// Reshapes the persisted rbac config in globalSettings.settings for two breaking changes:
//   1. rbac.globalRolePermissions -> rbac.roles (the source-of-truth rename)
//   2. rbac.roleAssignments['discord-server-member'] from a keyed, repeatable list [{ roles: string[] }]
//      to a flat string[] (there is only ever one "every member" bucket)
//
// Without this, the second change makes the whole GlobalSettingsSchema fail validation on load (a stored
// [{roles}] element is no longer a valid string[] item), which resets EVERY global setting to defaults, not
// just rbac. This migration keeps existing config intact instead.
//
// `settings` is stored superjson-wrapped ({ json, meta }) inside a drizzle json(text) column, so we parse the
// TEXT, mutate the plain `.json` payload, and write it back. The reshaped values are plain strings/objects, so
// the superjson `meta` (which only tags non-JSON types) never references them and is left untouched. Shapes are
// inlined per the frozen-in-time migration rule.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const rbac = wrapper?.json?.rbac
	if (!rbac || typeof rbac !== 'object') return

	let changed = false

	// 1. globalRolePermissions -> roles
	if (rbac.globalRolePermissions && typeof rbac.globalRolePermissions === 'object') {
		if (!rbac.roles || typeof rbac.roles !== 'object') rbac.roles = rbac.globalRolePermissions
		delete rbac.globalRolePermissions
		changed = true
	}

	// 2. flatten discord-server-member: [{ roles: [...] }, ...] -> [...roles] (deduped)
	const memberAssignments = rbac.roleAssignments?.['discord-server-member']
	if (Array.isArray(memberAssignments) && memberAssignments.some((e: any) => e && typeof e === 'object')) {
		const flat: string[] = []
		for (const entry of memberAssignments) {
			if (typeof entry === 'string') flat.push(entry)
			else if (entry && Array.isArray(entry.roles)) { for (const r of entry.roles) if (typeof r === 'string') flat.push(r) }
		}
		rbac.roleAssignments['discord-server-member'] = [...new Set(flat)]
		changed = true
	}

	if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
