import { z } from 'zod'
import * as M from '@/models'

export const RoleSchema = z.string().regex(/^[a-z0-9-]+$/)
export type Role = z.infer<typeof RoleSchema>

export const RoleAssignmentSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('discord-role'), discordRoleId: z.bigint(), role: RoleSchema }),
	z.object({ type: z.literal('discord-user'), discordUserId: z.bigint(), role: RoleSchema }),
	z.object({ type: z.literal('discord-server-member'), role: RoleSchema }),
])
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>

export const PERMISSION_SOURCE = z.enum(['config', 'programmatic'])

export const PERMISSION_TYPE = z.enum([
	'site:authorized', // Access the site
	'queue:modify', // Add, remove, edit or reorder layers in the queue
	'settings:write', // Change settings like the configured layer pool filter
	'vote:manage', // Start and abort votes
	'filters:write', // Delete or modify a filter
	'filters:write-all', // Delete or modify any filter
])
export type PermissionType = z.infer<typeof PERMISSION_TYPE>

export const ScopeSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('global'),
		}),
		z.object({
			type: z.literal('filter'),
			filterId: M.FilterEntityIdSchema,
		}),
	])
	.describe('attached to a permission, describing what it applies to')

export type Scope = z.infer<typeof ScopeSchema>

// could do fancy typescript stuff to not have to duplicate this, but it's not worth it imo
export const PERMISSION_TYPE_TO_SCOPE = {
	'site:authorized': 'global',
	'queue:modify': 'global',
	'settings:write': 'global',
	'vote:manage': 'global',
	'filters:write-all': 'global',
	'filters:write': 'filter',
}

export const SCOPE_TO_PERMISSION_TYPES = {
	global: z.enum(['site:authorized', 'queue:modify', 'settings:write', 'vote:manage', 'filters:write-all']),
	filter: z.enum(['filters:write']),
	source: PERMISSION_SOURCE,
}

export type Permission<T extends PermissionType = PermissionType> = {
	type: T
	scope: Extract<Scope, { type: (typeof PERMISSION_TYPE_TO_SCOPE)[T] }>
}
