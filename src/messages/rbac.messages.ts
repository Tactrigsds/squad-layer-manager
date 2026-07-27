import * as Msgs from '@/messages/shared'
import type * as RBAC from '@/rbac.models'

// Delivered in-game as a warn and in the web client as an error toast, which is why it declares both.
export const permissionDenied = Msgs.def((res: RBAC.PermissionDeniedResponse) => {
	const text = `Permission denied. You need ${res.checkType} of the following: ${res.failures.join(', ')}`
	return {
		warn: () => text,
		toast: () => [text],
		text: () => text,
	}
})

// -------- the roles editor --------

export const roleCount = Msgs.def('{count, plural, one {# role defined} other {# roles defined}}', (count: number) => ({ count }))

export const clearAllRoles = Msgs.def('Clear all')

export const noRoles = Msgs.def('No roles defined yet.')

export const newRoleId = Msgs.def('new-role-id')

export const selectARole = Msgs.def('Select or add a role to configure it.')

export const deleteRole = Msgs.def('Delete role')

// on the warning triangle beside an unassigned role in the list; the full sentence is in `roleUnassigned`
export const roleUnassignedShort = Msgs.def('No assignments, so this role is never granted to anyone')

export const roleUnassigned = Msgs.def('This role has no assignments, so it is never granted to anyone.')

// -------- permissions --------

export const permissions = Msgs.def('Permissions')

export const permissionsBlurb = Msgs.def(
	'Everything this role may do. Each row is one permission; its Scope narrows the permission to specific servers, settings or a duration cap. Leave a scope empty to grant it unrestricted.',
)

export const effectColumn = Msgs.def('Effect')

export const permissionColumn = Msgs.def('Permission')

export const scopeColumn = Msgs.def('Scope')

export const noPermissions = Msgs.def('This role grants nothing yet.')

export const allow = Msgs.def('Allow')

export const deny = Msgs.def('Deny')

export const allPermissions = Msgs.def('All permissions (*)')

export const subsumedByWildcard = Msgs.def('Already granted by the wildcard row above')

export const removePermission = Msgs.def('Remove this permission')

export const permissionPicker = Msgs.def('permission')

export const addPermission = Msgs.def('Add permission...')

// -------- permission scopes --------

// a denial carries no args, and an unscoped allow reaches everything
export const scopeEverything = Msgs.def('Everything')

// a permission that is neither scoped nor scopeable
export const scopeNone = Msgs.def('—')

// reads as "up to <duration>" and "up to <n> concurrent requests"
export const scopeUpTo = Msgs.def('up to')

export const scopeConcurrentRequests = Msgs.def('concurrent requests')

export const maxTimeoutPlaceholder = Msgs.def('2h')

// Each scope list names one kind of value. A locale cannot build "Add server" out of "server", so every phrase is
// spelled out rather than interpolated from the noun.
export type ScopeValueKind = 'setting-path' | 'server'

export const scopeValueLabels: Record<ScopeValueKind, { title: string; add: string; select: string }> = {
	'setting-path': { title: 'setting path', add: 'Add setting path', select: 'Select setting path...' },
	server: { title: 'server', add: 'Add server', select: 'Select server...' },
}

// an empty scope means unrestricted, which reads as a bug unless it is spelled out
export const scopeAllSettings = Msgs.def('All settings')

export const scopeAllNonSensitiveSettings = Msgs.def('All non-sensitive settings')

export const scopeAllServers = Msgs.def('All servers')

// -------- assignments --------

export const assignments = Msgs.def('Assignments')

export const assignmentsBlurb = Msgs.def(
	'Who is granted this role: Discord roles, users or members, in-game admins, or specific admin-list groups.',
)

export const everyMember = Msgs.def('Granted to every server member')

export const ingameAdminsOfLists = Msgs.def('In-game admins of these lists')

export const ingameAdminsHelp = Msgs.def(
	"A player is an in-game admin of a list when that list puts them in a group holding one of the list's own admin-identifying permissions. The role only applies on servers that use the list.",
)

export const adminListsLink = Msgs.def('Admin lists')

export const discordRoles = Msgs.def('Discord roles')

export const discordUsers = Msgs.def('Discord users')

export const adminListGroups = Msgs.def('Admin-list groups')

export const adminListGroupsHelp = Msgs.def(
	'Grant this role by admin-list group membership. A player gets it while the admin list places them in any selected group, admin-identifying or not (e.g. a Whitelist reserve-slot group).',
)

export const noAdminListGroups = Msgs.def('No admin-list groups are defined in the configured lists.')

export const groupPicker = Msgs.def('Group')

export const selectAdminListGroups = Msgs.def('Select admin-list groups...')

// a pair whose list or group has since gone; kept selectable so opening the editor never silently drops a grant
export const groupNotInAnyList = Msgs.def('{pair} (not in any current list)', (pair: string) => ({ pair }))

// -------- the env-configured bootstrap --------

export const superUsersAndRoles = Msgs.def('Super users & roles')

export const superBlurb = Msgs.def(
	'Configured through the SUPER_USERS / SUPER_ROLES environment variables. They always hold every permission (including unlimited kick timeouts) and cannot be modified from this page.',
)

export const superUsersLabel = Msgs.def('Users:')

export const superRolesLabel = Msgs.def('Discord roles:')

// -------- the user permissions dialog --------

export const userPermissionsTitle = Msgs.def('User Permissions')

export const userPermissionsBlurb = Msgs.def('View your current permissions and roles')

export const loadingUser = Msgs.def('Loading user data...')

export const simulate = Msgs.def('Simulate')

export const simulateBlurb = Msgs.def(
	'Toggle roles and permissions to see how the site behaves without them. You can only simulate losing access, never gaining it.',
)

export const byRoleTab = Msgs.def('By Role')

export const allPermissionsTab = Msgs.def('All Permissions')

export const heldPermissionCount = Msgs.def('You have {count, plural, one {# permission} other {# permissions}}', (count: number) => ({
	count,
}))

export const rolePermissionCount = Msgs.def('{count, plural, one {# permission} other {# permissions}}', (count: number) => ({ count }))

export const descriptionColumn = Msgs.def('Description')

export const grantedByColumn = Msgs.def('Granted By')

// a permission a role grants but a simulation has switched off, and the one doing the switching off
export const negatedBadge = Msgs.def('negated')

export const negatingBadge = Msgs.def('negating')

export const roleDisabledBadge = Msgs.def('Disabled')

export const unheldPermissionsHeading = Msgs.def("Permissions you don't have")

export const holdsEveryPermission = Msgs.def('You have every permission.')

export const unheldRolesHeading = Msgs.def("Roles you don't have")

export const unheldRolesBlurb = Msgs.def('A role can be simulated when everything it grants is already covered by your own permissions.')

export const holdsEveryRole = Msgs.def('You have every role.')

// why a role cannot be simulated: simulation may only take access away
export const roleGrantsMore = Msgs.def("Grants permissions you don't have")

// -------- the denied-action tooltip --------

export const permissionDeniedHeading = Msgs.def('Permission denied')

export const permissionsNeeded = Msgs.def(
	'{shape, select, single {You need the following permission:} all {You need all of the following permissions:} other {You need one of the following permissions:}}',
	(checkType: RBAC.PermissionDeniedResponse['checkType'], count: number) => ({
		shape: count === 1 ? 'single' : checkType === 'all' ? 'all' : 'any',
	}),
)
