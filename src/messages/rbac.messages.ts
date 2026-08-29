import { def, t } from '@/models/messages.models'
import type * as RBAC from '@/rbac.models'

// Delivered in-game as a warn and in the web client as an error toast, which is why it declares both.
export const permissionDenied = def((res: RBAC.PermissionDeniedResponse) => {
	const render = (locale?: string) =>
		t('Permission denied. You need {checkType} of the following: {failures}', {
			checkType: res.checkType,
			failures: res.failures.join(', '),
		})
	return {
		warn: ({ locale }) => render(locale),
		toast: [render()],
		text: render(),
	}
})

// -------- the roles editor --------

export const roleCount = def('{count, plural, one {# role defined} other {# roles defined}}', (count: number) => ({ count }))

export const clearAllRoles = def('Clear all')

export const noRoles = def('No roles defined yet.')

export const newRoleId = def('new-role-id')

export const selectARole = def('Select or add a role to configure it.')

export const deleteRole = def('Delete role')

// on the warning triangle beside an unassigned role in the list; the full sentence is in `roleUnassigned`
export const roleUnassignedShort = def('No assignments, so this role is never granted to anyone')

export const roleUnassigned = def('This role has no assignments, so it is never granted to anyone.')

// -------- permissions --------

export const permissions = def('Permissions')

export const permissionsBlurb = def(
	'Everything this role may do. Each row is one permission; its Scope narrows the permission to specific servers, settings or a duration cap. Leave a scope empty to grant it unrestricted.',
)

export const effectColumn = def('Effect')

export const permissionColumn = def('Permission')

export const scopeColumn = def('Scope')

export const noPermissions = def('This role grants nothing yet.')

export const allow = def('Allow')

export const deny = def('Deny')

export const allPermissions = def('All permissions (*)')

export const subsumedByWildcard = def('Already granted by the wildcard row above')

export const removePermission = def('Remove this permission')

export const permissionPicker = def('permission')

export const addPermission = def('Add permission...')

// -------- permission scopes --------

// a denial carries no args, and an unscoped allow reaches everything
export const scopeEverything = def('Everything')

// a permission that is neither scoped nor scopeable
export const scopeNone = def('—')

// reads as "up to <duration>" and "up to <n> concurrent requests"
export const scopeUpTo = def('up to')

export const scopeConcurrentRequests = def('concurrent requests')

export const maxTimeoutPlaceholder = def('2h')

// Each scope list names one kind of value. A locale cannot build "Add server" out of "server", so every phrase is
// spelled out rather than interpolated from the noun.
export type ScopeValueKind = 'setting-path' | 'server'

export const scopeValueLabels: Record<ScopeValueKind, { title: string; add: string; select: string }> = {
	'setting-path': { title: 'setting path', add: 'Add setting path', select: 'Select setting path...' },
	server: { title: 'server', add: 'Add server', select: 'Select server...' },
}

// an empty scope means unrestricted, which reads as a bug unless it is spelled out
export const scopeAllSettings = def('All settings')

export const scopeAllNonSensitiveSettings = def('All non-sensitive settings')

export const scopeAllServers = def('All servers')

// -------- assignments --------

export const assignments = def('Assignments')

export const assignmentsBlurb = def(
	'Who is granted this role: Discord roles, users or members, in-game admins, or specific admin-list groups.',
)

export const everyMember = def('Granted to every server member')

export const ingameAdminsOfLists = def('In-game admins of these lists')

export const ingameAdminsHelp = def(
	"A player is an in-game admin of a list when that list puts them in a group holding one of the list's own admin-identifying permissions. The role only applies on servers that use the list.",
)

export const adminListsLink = def('Admin lists')

export const discordRoles = def('Discord roles')

export const discordUsers = def('Discord users')

export const adminListGroups = def('Admin-list groups')

export const adminListGroupsHelp = def(
	'Grant this role by admin-list group membership. A player gets it while the admin list places them in any selected group, admin-identifying or not (e.g. a Whitelist reserve-slot group).',
)

export const noAdminListGroups = def('No admin-list groups are defined in the configured lists.')

export const groupPicker = def('Group')

export const selectAdminListGroups = def('Select admin-list groups...')

// a pair whose list or group has since gone; kept selectable so opening the editor never silently drops a grant
export const groupNotInAnyList = def('{pair} (not in any current list)', (pair: string) => ({ pair }))

// -------- the env-configured bootstrap --------

export const superUsersAndRoles = def('Super users & roles')

export const superBlurb = def(
	'Configured through the SUPER_USERS / SUPER_ROLES environment variables. They always hold every permission (including unlimited kick timeouts) and cannot be modified from this page.',
)

export const superUsersLabel = def('Users:')

export const superRolesLabel = def('Discord roles:')

// -------- the user permissions dialog --------

export const userPermissionsTitle = def('User Permissions')

export const userPermissionsBlurb = def('View your current permissions and roles')

export const loadingUser = def('Loading user data...')

export const simulate = def('Simulate')

export const simulateBlurb = def(
	'Toggle roles and permissions to see how the site behaves without them. You can only simulate losing access, never gaining it.',
)

export const byRoleTab = def('By Role')

export const allPermissionsTab = def('All Permissions')

export const heldPermissionCount = def('You have {count, plural, one {# permission} other {# permissions}}', (count: number) => ({
	count,
}))

export const rolePermissionCount = def('{count, plural, one {# permission} other {# permissions}}', (count: number) => ({ count }))

export const descriptionColumn = def('Description')

export const grantedByColumn = def('Granted By')

// a permission a role grants but a simulation has switched off, and the one doing the switching off
export const negatedBadge = def('negated')

export const negatingBadge = def('negating')

export const roleDisabledBadge = def('Disabled')

export const unheldPermissionsHeading = def("Permissions you don't have")

export const holdsEveryPermission = def('You have every permission.')

export const unheldRolesHeading = def("Roles you don't have")

export const unheldRolesBlurb = def('A role can be simulated when everything it grants is already covered by your own permissions.')

export const holdsEveryRole = def('You have every role.')

// why a role cannot be simulated: simulation may only take access away
export const roleGrantsMore = def("Grants permissions you don't have")

// -------- the denied-action tooltip --------

export const permissionDeniedHeading = def('Permission denied')

export const permissionsNeeded = def(
	'{shape, select, single {You need the following permission:} all {You need all of the following permissions:} other {You need one of the following permissions:}}',
	(checkType: RBAC.PermissionDeniedResponse['checkType'], count: number) => ({
		shape: count === 1 ? 'single' : checkType === 'all' ? 'all' : 'any',
	}),
)

export const pluginActions = def('Plugin Actions')

export const pluginActionsBlurb = def(
	'Actions the installed plugins define for themselves. A grant for a plugin that is not running does nothing, and is kept so stopping one does not lose it.',
)

export const noPluginActions = def('No running plugin defines an action.')

export const pluginActionServers = def('Servers')

export const pluginActionsUnresolved = def('Granted actions no running plugin defines:')

export const removeGrant = def('Remove')
