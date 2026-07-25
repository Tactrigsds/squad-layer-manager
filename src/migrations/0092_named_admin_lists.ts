import type { MigrationDriver } from '@/server/migrate'

// Admin lists become named things that servers and role assignments refer to individually.
//
//   globalSettings.adminListSources: AdminListSource[]        -> adminLists: Record<name, { source, adminIdentifyingPermissions }>
//   globalSettings.adminIdentifyingPermissions: PlayerPerm[]  -> per list (every migrated list inherits the old global set)
//   servers.<each>.adminLists                                 -> every existing list (they all applied to every server before)
//   rbac role assignments.includeIngameAdmins: boolean        -> ingameAdminLists: name[]
//   rbac role assignments.adminListGroups: string[]           -> { listId, groupId }[]
//
// Behaviour is preserved by fanning out: a bare group name could have come from any source, and in-game admin status
// was the union across all of them, so both expand to every list. Narrowing that is a judgement only an operator can
// make, and doing it here would silently revoke access.
//
// Names come from the source itself (its host or path) rather than being "list-1", because they show up in the server
// settings picker and in every role assignment, where a number would tell nobody anything.

type OldSource = { type: string; source?: string; host?: string; filePath?: string; username?: string }
type NewDef = { source: OldSource; adminIdentifyingPermissions: string[] }

function baseNameFor(source: OldSource): string {
	const raw = source.type === 'sftp'
		? `${source.host ?? 'sftp'}${source.filePath ?? ''}`
		: source.source ?? source.type
	// the file or endpoint the list actually comes from is the recognisable part
	const tail = raw.split(/[/\\]/).filter(Boolean).pop() ?? raw
	const cleaned = tail.replace(/\.(cfg|txt|ini)$/i, '').replace(/[^A-Za-z0-9 _-]/g, '-').replace(/^-+|-+$/g, '')
	return cleaned.length > 0 ? cleaned.slice(0, 64) : source.type
}

function uniqueName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base
	for (let n = 2;; n++) {
		const candidate = `${base}-${n}`
		if (!taken.has(candidate)) return candidate
	}
}

export async function up(db: MigrationDriver): Promise<void> {
	const gsRow = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!gsRow?.settings) return
	const gs = JSON.parse(gsRow.settings) as { json?: any; meta?: any }
	const json = gs?.json
	if (!json || typeof json !== 'object') return
	// already migrated
	if ('adminLists' in json) return

	const oldSources: OldSource[] = Array.isArray(json.adminListSources) ? json.adminListSources : []
	const oldPerms: string[] = Array.isArray(json.adminIdentifyingPermissions) ? json.adminIdentifyingPermissions : []

	const adminLists: Record<string, NewDef> = {}
	const taken = new Set<string>()
	const names: string[] = []
	for (const source of oldSources) {
		if (!source || typeof source !== 'object') continue
		const name = uniqueName(baseNameFor(source), taken)
		taken.add(name)
		names.push(name)
		adminLists[name] = { source, adminIdentifyingPermissions: [...oldPerms] }
	}

	json.adminLists = adminLists
	delete json.adminListSources
	delete json.adminIdentifyingPermissions

	// role assignments: both forms named "the admin list", which was the union of every source
	const roles = json.rbac?.roles
	if (roles && typeof roles === 'object') {
		for (const cfg of Object.values(roles) as any[]) {
			const a = cfg?.assignments
			if (!a || typeof a !== 'object') continue
			if ('includeIngameAdmins' in a) {
				a.ingameAdminLists = a.includeIngameAdmins ? [...names] : []
				delete a.includeIngameAdmins
			}
			if (Array.isArray(a.adminListGroups)) {
				a.adminListGroups = a.adminListGroups.flatMap((g: unknown) =>
					typeof g === 'string' ? names.map((listId) => ({ listId, groupId: g })) : []
				)
			}
		}
	}

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(JSON.stringify(gs), gsRow.id)

	// every server used every source before, so every server keeps every list
	const serverRows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		if (!wrapper?.json || typeof wrapper.json !== 'object') continue
		if ('adminLists' in wrapper.json) continue
		wrapper.json.adminLists = [...names]
		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}
}
