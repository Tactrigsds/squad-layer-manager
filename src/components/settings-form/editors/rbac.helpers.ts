import { type SchemaNode, stripNullable } from '@/components/settings-form/settings-form.helpers'
import { z } from '@/lib/zod'
import type * as PermRows from '@/models/rbac-perm-rows.models'
import * as SETTINGS from '@/models/settings.models'

// every dotted object path in a settings schema, in declaration order: the paths a settings grant may address.
// Stops at arrays/records since grants target the static object tree, not indices or dynamic keys.
function enumerateGrantPaths(node: SchemaNode, prefix = ''): string[] {
	const { inner } = stripNullable(node)
	if (inner?.type !== 'object' || !inner.properties || (inner.additionalProperties && typeof inner.additionalProperties === 'object')) {
		return []
	}
	const out: string[] = []
	for (const [key, child] of Object.entries(inner.properties as Record<string, SchemaNode>)) {
		const p = prefix ? `${prefix}.${key}` : key
		out.push(p, ...enumerateGrantPaths(child, p))
	}
	return out
}

let cachedGlobalGrantPaths: string[] | undefined

export function globalGrantPathOptions(): string[] {
	cachedGlobalGrantPaths ??= enumerateGrantPaths(
		z.toJSONSchema(SETTINGS.GlobalSettingsSchema, { io: 'input', unrepresentable: 'any' }) as SchemaNode,
	).filter((p) => p !== SETTINGS.COMMENTS_KEY)
	return cachedGlobalGrantPaths
}

// connections is excluded: it's gated by server-settings:write-sensitive, never by path grants
let cachedServerGrantPaths: string[] | undefined

export function serverGrantPathOptions(): string[] {
	cachedServerGrantPaths ??= enumerateGrantPaths(
		z.toJSONSchema(SETTINGS.ServerSettingsSchema, { io: 'input', unrepresentable: 'any' }) as SchemaNode,
	).filter((p) => p !== 'connections' && !p.startsWith('connections.') && p !== SETTINGS.COMMENTS_KEY)
	return cachedServerGrantPaths
}

//
// The whole `rbac` node renders as one master-detail editor: pick a role on the left, edit everything about it on the
// right. This mirrors the persisted shape, where each role is one object under `roles[roleId]` holding its permissions,
// timeout cap, settings grants and assignments.

export const VALID_ROLE_ID = /^[a-z0-9-]{3,32}$/

type RoleAssignmentsValue = PermRows.RoleAssignmentsValue

export type RoleConfig = PermRows.RoleConfig

export type RbacValue = PermRows.RbacValue

// apply `fn` to the whole rbac object, then poke reset$ so any uncontrolled inputs (the timeout duration field) re-read.
// `quiet` skips reset$ for edits driven by an uncontrolled input, where re-emitting would clobber an in-flight keystroke.
export type RbacUpdate = (fn: (rbac: RbacValue) => RbacValue, quiet?: boolean) => void

// set/replace one role's config immutably
export function withRoleConfig(rbac: RbacValue, roleId: string, fn: (cfg: RoleConfig) => RoleConfig): RbacValue {
	const roles = { ...(rbac.roles ?? {}) }
	roles[roleId] = fn(roles[roleId] ?? {})
	return { ...rbac, roles }
}

// set a config field, dropping it when empty so the persisted role stays free of empty maps/arrays
function setRoleField<K extends keyof RoleConfig>(cfg: RoleConfig, key: K, val: RoleConfig[K] | undefined): RoleConfig {
	const next = { ...cfg }
	if (val === undefined || (Array.isArray(val) && val.length === 0)) delete next[key]
	else next[key] = val as RoleConfig[K]
	return next
}

// merge into a role's assignments, dropping the whole `assignments` object once nothing is assigned
export function withAssignments(cfg: RoleConfig, patch: Partial<RoleAssignmentsValue>): RoleConfig {
	const a: RoleAssignmentsValue = { ...cfg.assignments, ...patch }
	return setRoleField(cfg, 'assignments', isAssignmentEmpty(a) ? undefined : a)
}

function isAssignmentEmpty(a: RoleAssignmentsValue): boolean {
	return (
		(a.discordRoleIds?.length ?? 0) === 0 &&
		(a.discordUserIds?.length ?? 0) === 0 &&
		!a.everyMember &&
		(a.ingameAdminLists?.length ?? 0) === 0 &&
		(a.adminListGroups?.length ?? 0) === 0
	)
}

// "list/group" for the multi-select, which deals in flat strings. Neither an admin list name nor a Squad group name
// may contain a slash, so the first one separates them unambiguously.
export function encodeListGroup(listId: string, groupId: string): string {
	return `${listId}/${groupId}`
}

export function decodeListGroup(pair: string): { listId: string; groupId: string } | null {
	const idx = pair.indexOf('/')
	if (idx <= 0 || idx === pair.length - 1) return null
	return { listId: pair.slice(0, idx), groupId: pair.slice(idx + 1) }
}

export function isRoleAssigned(cfg: RoleConfig | undefined): boolean {
	const a = cfg?.assignments
	return !!a && !isAssignmentEmpty(a)
}

export function withRoleRemoved(rbac: RbacValue, roleId: string): RbacValue {
	const roles = { ...(rbac.roles ?? {}) }
	delete roles[roleId]
	return { ...rbac, roles }
}

export function withRoleRenamed(rbac: RbacValue, oldId: string, newId: string): RbacValue {
	const roles: Record<string, RoleConfig> = {}
	for (const [k, v] of Object.entries(rbac.roles ?? {})) roles[k === oldId ? newId : k] = v
	return { ...rbac, roles }
}
