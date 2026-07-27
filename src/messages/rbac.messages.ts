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

export const roleCount = Msgs.def((count: number) => ({ text: () => `${count} role${count === 1 ? '' : 's'} defined` }))

export const clearAllRoles = Msgs.def(() => ({ text: () => 'Clear all' }))

export const noRoles = Msgs.def(() => ({ text: () => 'No roles defined yet.' }))

export const newRoleId = Msgs.def(() => ({ text: () => 'new-role-id' }))

export const selectARole = Msgs.def(() => ({ text: () => 'Select or add a role to configure it.' }))

export const deleteRole = Msgs.def(() => ({ text: () => 'Delete role' }))

// on the warning triangle beside an unassigned role in the list; the full sentence is in `roleUnassigned`
export const roleUnassignedShort = Msgs.def(() => ({ text: () => 'No assignments, so this role is never granted to anyone' }))

export const roleUnassigned = Msgs.def(() => ({ text: () => 'This role has no assignments, so it is never granted to anyone.' }))

// -------- permissions --------

export const permissions = Msgs.def(() => ({ text: () => 'Permissions' }))

export const permissionsBlurb = Msgs.def(() => ({
	text: () =>
		'Everything this role may do. Each row is one permission; its Scope narrows the permission to specific servers, settings ' +
		'or a duration cap. Leave a scope empty to grant it unrestricted.',
}))

export const effectColumn = Msgs.def(() => ({ text: () => 'Effect' }))

export const permissionColumn = Msgs.def(() => ({ text: () => 'Permission' }))

export const scopeColumn = Msgs.def(() => ({ text: () => 'Scope' }))

export const noPermissions = Msgs.def(() => ({ text: () => 'This role grants nothing yet.' }))

export const allow = Msgs.def(() => ({ text: () => 'Allow' }))

export const deny = Msgs.def(() => ({ text: () => 'Deny' }))

export const allPermissions = Msgs.def(() => ({ text: () => 'All permissions (*)' }))

export const subsumedByWildcard = Msgs.def(() => ({ text: () => 'Already granted by the wildcard row above' }))

export const removePermission = Msgs.def(() => ({ text: () => 'Remove this permission' }))

export const permissionPicker = Msgs.def(() => ({ text: () => 'permission' }))

export const addPermission = Msgs.def(() => ({ text: () => 'Add permission...' }))

// -------- permission scopes --------

// a denial carries no args, and an unscoped allow reaches everything
export const scopeEverything = Msgs.def(() => ({ text: () => 'Everything' }))

// a permission that is neither scoped nor scopeable
export const scopeNone = Msgs.def(() => ({ text: () => '—' }))

// reads as "up to <duration>" and "up to <n> concurrent requests"
export const scopeUpTo = Msgs.def(() => ({ text: () => 'up to' }))

export const scopeConcurrentRequests = Msgs.def(() => ({ text: () => 'concurrent requests' }))

export const maxTimeoutPlaceholder = Msgs.def(() => ({ text: () => '2h' }))

// Each scope list names one kind of value. A locale cannot build "Add server" out of "server", so every phrase is
// spelled out rather than interpolated from the noun.
export type ScopeValueKind = 'setting-path' | 'server'

export const scopeValueLabels: Record<ScopeValueKind, { title: string; add: string; select: string }> = {
	'setting-path': { title: 'setting path', add: 'Add setting path', select: 'Select setting path...' },
	server: { title: 'server', add: 'Add server', select: 'Select server...' },
}

// an empty scope means unrestricted, which reads as a bug unless it is spelled out
export const scopeAllSettings = Msgs.def(() => ({ text: () => 'All settings' }))

export const scopeAllNonSensitiveSettings = Msgs.def(() => ({ text: () => 'All non-sensitive settings' }))

export const scopeAllServers = Msgs.def(() => ({ text: () => 'All servers' }))

// -------- assignments --------

export const assignments = Msgs.def(() => ({ text: () => 'Assignments' }))

export const assignmentsBlurb = Msgs.def(() => ({
	text: () => 'Who is granted this role: Discord roles, users or members, in-game admins, or specific admin-list groups.',
}))

export const everyMember = Msgs.def(() => ({ text: () => 'Granted to every server member' }))

export const ingameAdminsOfLists = Msgs.def(() => ({ text: () => 'In-game admins of these lists' }))

export const ingameAdminsHelp = Msgs.def(() => ({
	text: () =>
		`A player is an in-game admin of a list when that list puts them in a group holding one of the list's own ` +
		'admin-identifying permissions. The role only applies on servers that use the list.',
}))

export const adminListsLink = Msgs.def(() => ({ text: () => 'Admin lists' }))

export const discordRoles = Msgs.def(() => ({ text: () => 'Discord roles' }))

export const discordUsers = Msgs.def(() => ({ text: () => 'Discord users' }))

export const adminListGroups = Msgs.def(() => ({ text: () => 'Admin-list groups' }))

export const adminListGroupsHelp = Msgs.def(() => ({
	text: () =>
		'Grant this role by admin-list group membership. A player gets it while the admin list places them in any selected group, ' +
		'admin-identifying or not (e.g. a Whitelist reserve-slot group).',
}))

export const noAdminListGroups = Msgs.def(() => ({ text: () => 'No admin-list groups are defined in the configured lists.' }))

export const groupPicker = Msgs.def(() => ({ text: () => 'Group' }))

export const selectAdminListGroups = Msgs.def(() => ({ text: () => 'Select admin-list groups...' }))

// a pair whose list or group has since gone; kept selectable so opening the editor never silently drops a grant
export const groupNotInAnyList = Msgs.def((pair: string) => ({ text: () => `${pair} (not in any current list)` }))

// -------- the env-configured bootstrap --------

export const superUsersAndRoles = Msgs.def(() => ({ text: () => 'Super users & roles' }))

export const superBlurb = Msgs.def(() => ({
	text: () =>
		'Configured through the SUPER_USERS / SUPER_ROLES environment variables. They always hold every permission (including ' +
		'unlimited kick timeouts) and cannot be modified from this page.',
}))

export const superUsersLabel = Msgs.def(() => ({ text: () => 'Users:' }))

export const superRolesLabel = Msgs.def(() => ({ text: () => 'Discord roles:' }))

// -------- the user permissions dialog --------

export const userPermissionsTitle = Msgs.def(() => ({ text: () => 'User Permissions' }))

export const userPermissionsBlurb = Msgs.def(() => ({ text: () => 'View your current permissions and roles' }))

export const loadingUser = Msgs.def(() => ({ text: () => 'Loading user data...' }))

export const simulate = Msgs.def(() => ({ text: () => 'Simulate' }))

export const simulateBlurb = Msgs.def(() => ({
	text: () =>
		'Toggle roles and permissions to see how the site behaves without them. You can only simulate losing access, never gaining it.',
}))

export const byRoleTab = Msgs.def(() => ({ text: () => 'By Role' }))

export const allPermissionsTab = Msgs.def(() => ({ text: () => 'All Permissions' }))

export const heldPermissionCount = Msgs.def((count: number) => ({
	text: () => `You have ${count} permission${count !== 1 ? 's' : ''}`,
}))

export const rolePermissionCount = Msgs.def((count: number) => ({ text: () => `${count} permission${count !== 1 ? 's' : ''}` }))

export const descriptionColumn = Msgs.def(() => ({ text: () => 'Description' }))

export const grantedByColumn = Msgs.def(() => ({ text: () => 'Granted By' }))

// a permission a role grants but a simulation has switched off, and the one doing the switching off
export const negatedBadge = Msgs.def(() => ({ text: () => 'negated' }))

export const negatingBadge = Msgs.def(() => ({ text: () => 'negating' }))

export const roleDisabledBadge = Msgs.def(() => ({ text: () => 'Disabled' }))

export const unheldPermissionsHeading = Msgs.def(() => ({ text: () => `Permissions you don't have` }))

export const holdsEveryPermission = Msgs.def(() => ({ text: () => 'You have every permission.' }))

export const unheldRolesHeading = Msgs.def(() => ({ text: () => `Roles you don't have` }))

export const unheldRolesBlurb = Msgs.def(() => ({
	text: () => 'A role can be simulated when everything it grants is already covered by your own permissions.',
}))

export const holdsEveryRole = Msgs.def(() => ({ text: () => 'You have every role.' }))

// why a role cannot be simulated: simulation may only take access away
export const roleGrantsMore = Msgs.def(() => ({ text: () => `Grants permissions you don't have` }))

// -------- the denied-action tooltip --------

export const permissionDeniedHeading = Msgs.def(() => ({ text: () => 'Permission denied' }))

export const permissionsNeeded = Msgs.def((checkType: RBAC.PermissionDeniedResponse['checkType'], count: number) => ({
	text: () =>
		count === 1
			? 'You need the following permission:'
			: checkType === 'all'
				? 'You need all of the following permissions:'
				: 'You need one of the following permissions:',
}))
