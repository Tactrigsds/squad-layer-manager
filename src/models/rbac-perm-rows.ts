import { assertNever } from '@/lib/type-guards'
import * as RBAC from '@/rbac.models'

// A role's permissions are persisted across five parallel fields (`permissions` expressions, `maxTimeout`,
// `globalSettingsGrants`, `serverSettingsGrants`), because the expression grammar can't carry scope arguments. The editor
// presents all of them as one flat list of rows instead: one row = one permission, held with some scope. This module is
// the projection between the two, and it is intentionally the only place that knows the correspondence.
//
// The row list is a *view*: rows are derived from the config on every read and distributed back on every write, so the
// persisted shape is untouched.

export type ServerGrant = { access: string; serverIds?: string[]; paths?: string[] }
export type RoleAssignmentsValue = { discordRoleIds?: (string | number)[]; discordUserIds?: (string | number)[]; everyMember?: boolean }
export type RoleConfig = {
	permissions?: string[]
	maxTimeout?: string
	globalSettingsGrants?: string[]
	serverSettingsGrants?: ServerGrant[]
	assignments?: RoleAssignmentsValue
}
export type RbacValue = { roles?: Record<string, RoleConfig> }

export type Effect = 'allow' | 'deny'

// what the row's Scope cell edits. Mirrors the permission's `scope` in PERMISSION_DEFINITION, plus `all` for the `*`
// wildcard expression, which is a row but not a permission.
export type RowScope =
	| 'all'
	| 'global'
	| 'timeout'
	| 'global-settings-write'
	| 'server-settings'
	| 'server-settings-write'

export type PermRow = {
	// deterministic: rows are re-derived from the config on every render, so this must not be random
	id: string
	type: string
	effect: Effect
	// scope args; which of these the row uses is decided by `rowScope(type)`. Empty array = unrestricted ("all").
	serverIds?: string[]
	paths?: string[]
	maxTimeout?: string
}

export const ALL_PERMISSIONS = '*'
// matches the duration the old kick-timeout switch seeded on enable
export const DEFAULT_MAX_TIMEOUT = '1h'

// permissions the table can add. `filters:write` is absent on purpose: it's granted by the inferred filter-owner /
// filter-contributor roles, never by a role definition.
export const ADDABLE_TYPES: string[] = [
	ALL_PERMISSIONS,
	...RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options,
	// not role-grantable as an expression (it rides `maxTimeout`), but it is a row
	'squad-server:timeout-players',
]

// declaration order in PERMISSION_DEFINITION, so the table lists permissions in the same order every time regardless of
// how they happen to be stored
const TYPE_ORDER = [ALL_PERMISSIONS, ...Object.keys(RBAC.PERMISSION_DEFINITION)]

export function rowScope(type: string): RowScope {
	if (type === ALL_PERMISSIONS) return 'all'
	const def = RBAC.PERMISSION_DEFINITION[type as keyof typeof RBAC.PERMISSION_DEFINITION]
	if (!def) throw new Error(`unknown permission type: ${type}`)
	const scope = def.scope
	if (scope === 'filter') throw new Error(`${type} is inferred-only and cannot be a role permission row`)
	return scope
}

export function permDescription(type: string): string | undefined {
	if (type === ALL_PERMISSIONS) return 'Grants every permission (full access to everything)'
	return RBAC.PERMISSION_DEFINITION[type as keyof typeof RBAC.PERMISSION_DEFINITION]?.description
}

// `!squad-server:timeout-players` isn't in the expression grammar, and negating a "up to N" cap is meaningless anyway:
// to remove the ability you drop the row. `*` denies nothing.
export function canDeny(type: string): boolean {
	return type !== ALL_PERMISSIONS && RBAC.isRoleGrantablePermissionType(type as RBAC.RolePermissionExpression)
}

function serverAccessOf(type: string): string {
	return type.slice('server-settings:'.length)
}

// the scope args a row starts with. Empty arrays mean unrestricted, matching what a bare expression grants.
function emptyArgs(type: string): Partial<PermRow> {
	const scope = rowScope(type)
	switch (scope) {
		case 'all':
		case 'global':
			return {}
		case 'timeout':
			return { maxTimeout: DEFAULT_MAX_TIMEOUT }
		case 'global-settings-write':
			return { paths: [] }
		case 'server-settings':
			return { serverIds: [] }
		case 'server-settings-write':
			return { serverIds: [], paths: [] }
		default:
			return assertNever(scope)
	}
}

export function newRow(type: string, effect: Effect = 'allow'): PermRow {
	return { id: '', type, effect, ...(effect === 'deny' ? {} : emptyArgs(type)) }
}

// stable order + ids. Ids only have to survive re-derivation of the same config, which ordinal-within-(type,effect) does.
function finalize(rows: PermRow[]): PermRow[] {
	const sorted = [...rows].sort((a, b) => {
		const ta = TYPE_ORDER.indexOf(a.type)
		const tb = TYPE_ORDER.indexOf(b.type)
		if (ta !== tb) return ta - tb
		if (a.effect !== b.effect) return a.effect === 'allow' ? -1 : 1
		return 0
	})
	const seen = new Map<string, number>()
	return sorted.map((row) => {
		const key = `${row.effect}|${row.type}`
		const ordinal = seen.get(key) ?? 0
		seen.set(key, ordinal + 1)
		return { ...row, id: `${key}|${ordinal}` }
	})
}

export function rowsFromConfig(cfg: RoleConfig): PermRow[] {
	const rows: PermRow[] = []
	const exprs = cfg.permissions ?? []
	const bare = new Set(exprs.filter((p) => !p.startsWith('!')))

	for (const type of bare) {
		// a bare settings expression grants that permission unrestricted, which is an empty-args row
		if (type === ALL_PERMISSIONS || RBAC.isRoleGrantablePermissionType(type as RBAC.RolePermissionExpression)) {
			rows.push({ id: '', type, effect: 'allow', ...emptyArgs(type) })
		}
	}

	// restricted grants are dead config whenever the bare (unrestricted) expression is also present -- it already grants
	// strictly more. Collapsing to the single unrestricted row is semantically lossless and surfaces the redundancy.
	if (!bare.has('global-settings:write') && (cfg.globalSettingsGrants?.length ?? 0) > 0) {
		rows.push({ id: '', type: 'global-settings:write', effect: 'allow', paths: [...cfg.globalSettingsGrants!] })
	}

	for (const grant of cfg.serverSettingsGrants ?? []) {
		const type = `server-settings:${grant.access}`
		if (bare.has(type) || !RBAC.isRoleGrantablePermissionType(type as RBAC.RolePermissionExpression)) continue
		rows.push({
			id: '',
			type,
			effect: 'allow',
			serverIds: [...(grant.serverIds ?? [])],
			// paths only mean anything on a write grant; the schema rejects them elsewhere
			...(grant.access === 'write' ? { paths: [...(grant.paths ?? [])] } : {}),
		})
	}

	if (cfg.maxTimeout !== undefined) {
		rows.push({ id: '', type: 'squad-server:timeout-players', effect: 'allow', maxTimeout: cfg.maxTimeout })
	}

	for (const expr of exprs) {
		if (!expr.startsWith('!')) continue
		const type = expr.slice(1)
		if (RBAC.isRoleGrantablePermissionType(type as RBAC.RolePermissionExpression)) rows.push({ id: '', type, effect: 'deny' })
	}

	return finalize(rows)
}

export function configFromRows(cfg: RoleConfig, rows: PermRow[]): RoleConfig {
	const permissions: string[] = []
	const globalSettingsGrants: string[] = []
	const serverSettingsGrants: ServerGrant[] = []
	let maxTimeout: string | undefined

	for (const row of rows) {
		if (row.effect === 'deny') {
			permissions.push(`!${row.type}`)
			continue
		}
		const scope = rowScope(row.type)
		switch (scope) {
			case 'all':
			case 'global':
				permissions.push(row.type)
				break
			case 'timeout':
				maxTimeout = row.maxTimeout || DEFAULT_MAX_TIMEOUT
				break
			case 'global-settings-write':
				// no paths = unrestricted, which only the bare expression can express
				if ((row.paths?.length ?? 0) === 0) permissions.push(row.type)
				else globalSettingsGrants.push(...row.paths!)
				break
			case 'server-settings':
				if ((row.serverIds?.length ?? 0) === 0) permissions.push(row.type)
				else serverSettingsGrants.push({ access: serverAccessOf(row.type), serverIds: [...row.serverIds!] })
				break
			case 'server-settings-write':
				if ((row.serverIds?.length ?? 0) === 0 && (row.paths?.length ?? 0) === 0) permissions.push(row.type)
				else {
					serverSettingsGrants.push({
						access: 'write',
						serverIds: [...(row.serverIds ?? [])],
						paths: [...(row.paths ?? [])],
					})
				}
				break
			default:
				assertNever(scope)
		}
	}

	// the three lists are written even when empty, because their schemas prefault to []: dropping them would leave the
	// editor's draft permanently one "change" away from the document it just saved.
	const next: RoleConfig = {
		...cfg,
		permissions: [...new Set(permissions)],
		globalSettingsGrants: [...new Set(globalSettingsGrants)],
		serverSettingsGrants,
	}
	// maxTimeout is genuinely optional though: absent means the role cannot issue timeouts at all, so an absent row has to
	// drop the field rather than write a falsy cap.
	if (maxTimeout === undefined) delete next.maxTimeout
	else next.maxTimeout = maxTimeout
	return next
}
