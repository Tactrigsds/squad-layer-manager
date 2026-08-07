import type * as RBAC from '@/rbac.models'

// What a demo-fleet guild instance is, on the instance's own side. One of these is provisioned by installing the
// demo application into a discord server: it runs with DEMO off, real identities and real permissions, and only
// the squad server under it is emulated. See dev_docs/demo_fleet.md.
//
// The two roles below are the whole of its rbac bootstrap. Nobody deployed this instance, so nobody got to set
// SUPER_USERS on it: every member is signed in and given a look, and the first person holding Manage Guild to
// arrive chooses which guild role runs it.

export const MEMBERS_ROLE_ID = 'guild-members'
export const FULL_ACCESS_ROLE_ID = 'guild-owners'

const MEMBER_PERMISSIONS: RBAC.RolePermissionExpression[] = ['site:authorized', 'squad-server:view']
const FULL_ACCESS_PERMISSIONS: RBAC.RolePermissionExpression[] = ['*']

// Merged over the tiered preset a fresh install starts from, rather than replacing it: an instance keeps admins /
// managers / owners, which are what its in-game admin list grants against.
export function initialRoles() {
	return {
		[MEMBERS_ROLE_ID]: {
			permissions: MEMBER_PERMISSIONS,
			assignments: { everyMember: true },
		},
		[FULL_ACCESS_ROLE_ID]: {
			permissions: FULL_ACCESS_PERMISSIONS,
			// deliberately unassigned: this is the choice the first-login role pick makes
			assignments: {},
		},
	}
}

// Which guild role runs the instance, or null while nobody has picked one. Read off the settings rather than
// stored separately, so editing the role's assignments on the settings page is the same act as picking here.
export function chosenFullAccessRoleId(rbac: { roles: Record<string, { assignments: { discordRoleIds: string[] } }> }): string | null {
	return rbac.roles[FULL_ACCESS_ROLE_ID]?.assignments.discordRoleIds[0] ?? null
}
