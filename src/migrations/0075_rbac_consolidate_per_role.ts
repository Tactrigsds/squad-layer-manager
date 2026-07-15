import type { MigrationDriver } from '@/server/migrate'

// Consolidates the persisted rbac config in globalSettings.settings from five parallel role-keyed maps into one
// object per role. Before:
//   rbac.roles:                Record<roleId, permissionExpr[]>
//   rbac.roleAssignments:      { 'discord-role': [{discordRoleId, roles[]}], 'discord-user': [{userId, roles[]}], 'discord-server-member': roleId[] }
//   rbac.maxTimeouts:          Record<roleId, HumanTime>
//   rbac.globalSettingsGrants: Record<roleId, string[]>
//   rbac.serverSettingsGrants: Record<roleId, grant[]>
// After:
//   rbac.roles: Record<roleId, {
//     permissions: permissionExpr[],
//     maxTimeout?: HumanTime,
//     globalSettingsGrants?: string[],
//     serverSettingsGrants?: grant[],
//     assignments: { discordRoleIds: string[], discordUserIds: string[], everyMember: boolean },
//   }>
//
// The assignment maps are inverted here: each role gathers the discord role/user ids that granted it (and whether it
// was in the every-member bucket). Without this migration the reshaped GlobalSettingsSchema fails to validate on load
// (the old rbac.roles value is a bare array, not the new object), which would reset EVERY global setting to defaults.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; we parse the TEXT, mutate the
// plain `.json` payload and write it back. All reshaped values are plain strings/objects/booleans, so the superjson
// `meta` (which only tags non-JSON types) never references them and is left untouched. Shapes are inlined per the
// frozen-in-time migration rule.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const rbac = wrapper?.json?.rbac
	if (!rbac || typeof rbac !== 'object') return

	const oldRoles = rbac.roles
	// already migrated (roles values are objects, not arrays) or nothing to do
	if (!oldRoles || typeof oldRoles !== 'object') return
	const roleIds = Object.keys(oldRoles)
	if (roleIds.length > 0 && !Array.isArray(oldRoles[roleIds[0]])) return

	const oldAssignments = (rbac.roleAssignments ?? {}) as {
		'discord-role'?: { discordRoleId?: unknown; roles?: string[] }[]
		'discord-user'?: { userId?: unknown; roles?: string[] }[]
		'discord-server-member'?: string[]
	}
	const oldMaxTimeouts = (rbac.maxTimeouts ?? {}) as Record<string, unknown>
	const oldGlobalGrants = (rbac.globalSettingsGrants ?? {}) as Record<string, unknown>
	const oldServerGrants = (rbac.serverSettingsGrants ?? {}) as Record<string, unknown>

	type Config = {
		permissions: unknown
		maxTimeout?: unknown
		globalSettingsGrants?: unknown
		serverSettingsGrants?: unknown
		assignments: { discordRoleIds: string[]; discordUserIds: string[]; everyMember: boolean }
	}

	const nextRoles: Record<string, Config> = {}
	for (const roleId of roleIds) {
		nextRoles[roleId] = {
			permissions: Array.isArray(oldRoles[roleId]) ? oldRoles[roleId] : [],
			assignments: { discordRoleIds: [], discordUserIds: [], everyMember: false },
		}
		if (roleId in oldMaxTimeouts) nextRoles[roleId].maxTimeout = oldMaxTimeouts[roleId]
		if (Array.isArray(oldGlobalGrants[roleId]) && (oldGlobalGrants[roleId] as unknown[]).length > 0) {
			nextRoles[roleId].globalSettingsGrants = oldGlobalGrants[roleId]
		}
		if (Array.isArray(oldServerGrants[roleId]) && (oldServerGrants[roleId] as unknown[]).length > 0) {
			nextRoles[roleId].serverSettingsGrants = oldServerGrants[roleId]
		}
	}

	// invert the assignment maps onto each role (dropping references to roles that were never defined)
	const addTo = (roleId: string, bucket: 'discordRoleIds' | 'discordUserIds', id: unknown) => {
		const cfg = nextRoles[roleId]
		if (!cfg) return
		const str = String(id)
		if (!cfg.assignments[bucket].includes(str)) cfg.assignments[bucket].push(str)
	}
	for (const entry of oldAssignments['discord-role'] ?? []) {
		for (const roleId of entry.roles ?? []) addTo(roleId, 'discordRoleIds', entry.discordRoleId)
	}
	for (const entry of oldAssignments['discord-user'] ?? []) {
		for (const roleId of entry.roles ?? []) addTo(roleId, 'discordUserIds', entry.userId)
	}
	for (const roleId of oldAssignments['discord-server-member'] ?? []) {
		if (nextRoles[roleId]) nextRoles[roleId].assignments.everyMember = true
	}

	rbac.roles = nextRoles
	delete rbac.roleAssignments
	delete rbac.maxTimeouts
	delete rbac.globalSettingsGrants
	delete rbac.serverSettingsGrants

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
