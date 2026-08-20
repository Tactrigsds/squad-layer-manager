import { useQuery } from '@tanstack/react-query'

import * as Obj from '@/lib/object-utils'
import { useStable } from '@/lib/react'
import * as RSel from '@/lib/reselect'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import type { PublicSettings } from '@/systems/settings.server'
import * as UsersClient from '@/systems/users.client'

export function handlePermissionDenied(res: RBAC.PermissionDeniedResponse) {
	UsersClient.invalidateLoggedInUser()
	toast.error(...tr.toast(RBAC_Msgs.permissionDenied(res)))
}

export function usePermsCheck<T extends RBAC.PermissionType>(
	req: RBAC.PermitChecker<T> | RBAC.PermitChecker<T>[] | RBAC.PermissionReq<T>,
): RBAC.PermissionDeniedResponse | null {
	return Zus.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.permsCheck(useStable(req)))
}

// for the affordances rendered where no server is in scope; see RBAC.hasPermOnAnyServer for why that is acceptable
export function useAnyServerPermsCheck(type: RBAC.ServerPermissionType): RBAC.PermissionDeniedResponse | null {
	return usePermsCheck((perms) => (RBAC.hasPermOnAnyServer(perms, type) ? undefined : type))
}

// the logged-in user's effective (non-negated) permissions, for the aggregate settings-access checks below
export function useSuspendableLoggedInUserPerms(): RBAC.Permission[] {
	return Zus.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.loggedInUserPerms)
}

export type GlobalSettingsAccess = { canRead: boolean; write: RBAC.SettingsWriteAccess }
export function useGlobalSettingsAccess(): GlobalSettingsAccess {
	return Zus.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.globalSettingsAccess)
}

export type ServerSettingsAccess = { canRead: boolean; write: RBAC.SettingsWriteAccess; sensitive: boolean }
export function useServerSettingsAccess(serverId: string): ServerSettingsAccess {
	return Zus.useStore_Susp(UsersClient.loggedInUserQueryOptions, RbacStore, Sel.serverSettingsAccess(serverId))
}

// module-level so they double as stable `Zus.useStore` sources, and so the option objects aren't rebuilt per render
export const userDefinedRolesQueryOptions = RPC.orpc.rbac.getUserDefinedRoles.queryOptions()
export const myRolesQueryOptions = RPC.orpc.rbac.getMyRoles.queryOptions()
export const simulatableRolesQueryOptions = RPC.orpc.rbac.getSimulatableRoles.queryOptions()

export type UserDefinedRole = Awaited<ReturnType<typeof RPC.orpc.rbac.getUserDefinedRoles.call>>[number]

export function useUserDefinedRoles() {
	return useQuery(userDefinedRolesQueryOptions)
}

// the user's own roles. Can't be derived from their permissions' traces, since a role granting nothing appears in none
export function useMyRoles() {
	return useQuery(myRolesQueryOptions)
}

// roles the user doesn't hold but may simulate holding, along with the permissions each would grant
export type SimulatableRole = { role: RBAC.Role; perms: RBAC.TracedPermission[] }
export function useSimulatableRoles() {
	return useQuery(simulatableRolesQueryOptions)
}

// simulation can only ever narrow what the user can do: roles and permissions may be switched off, and roles may only
// be switched on when the server has vouched that they grant nothing the user doesn't already have.
export type RbacStore = {
	simulate: boolean
	setSimulate: (simulate: boolean) => void
	disabledRoles: RBAC.Role[]
	disableRole: (role: RBAC.Role) => void
	enableRole: (role: RBAC.Role) => void
	// simulatable roles the user has opted into, carrying the perms the server attributed to them
	addedRoles: SimulatableRole[]
	addRole: (added: SimulatableRole) => void
	removeRole: (role: RBAC.Role) => void
	// permissions switched off individually, independent of the roles granting them
	disabledPerms: RBAC.Permission[]
	disablePerm: (perm: RBAC.Permission) => void
	enablePerm: (perm: RBAC.Permission) => void
}

export const RbacStore = Zus.createStore<RbacStore>((set, get) => ({
	simulate: false,
	setSimulate: (simulate: boolean) => {
		if (!simulate) {
			set({ simulate, disabledRoles: [], addedRoles: [], disabledPerms: [] })
			return
		}
		set({ simulate })
	},

	disabledRoles: [],
	disableRole: (roleToDisable) => {
		const disabledRoles = get().disabledRoles
		if (disabledRoles.some((r) => Obj.deepEqual(roleToDisable, r))) return
		set({ disabledRoles: [...disabledRoles, roleToDisable] })
	},
	enableRole: (role) => set({ disabledRoles: get().disabledRoles.filter((r) => !Obj.deepEqual(r, role)) }),

	addedRoles: [],
	addRole: (added) => {
		const addedRoles = get().addedRoles
		if (addedRoles.some((a) => Obj.deepEqual(a.role, added.role))) return
		set({ addedRoles: [...addedRoles, added], disabledRoles: get().disabledRoles.filter((r) => !Obj.deepEqual(r, added.role)) })
	},
	removeRole: (role) => set({ addedRoles: get().addedRoles.filter((a) => !Obj.deepEqual(a.role, role)) }),

	disabledPerms: [],
	disablePerm: (perm) => {
		const disabledPerms = get().disabledPerms
		if (disabledPerms.some((p) => RBAC.isSamePerm(p, perm))) return
		set({ disabledPerms: [...disabledPerms, Obj.selectProps(perm, ['type', 'scope', 'args']) as RBAC.Permission] })
	},
	enablePerm: (perm) => set({ disabledPerms: get().disabledPerms.filter((p) => !RBAC.isSamePerm(p, perm)) }),
}))

const SERVER_REGISTRY_REQ: RBAC.PermissionReq<RBAC.PermissionType> = {
	check: 'any',
	permits: [RBAC.perm('admin:manage-servers'), RBAC.perm('admin:delete-servers')],
}

export namespace Sel {
	// indirected rather than passed straight in: users.client and this module import each other, so reading
	// UsersClient.Sel at module-init time would depend on which of the two the bundler evaluates first
	const loggedInUser = (...args: [user: RBAC.UserWithRbac, rbacStore: RbacStore]) => UsersClient.Sel.loggedInUser(...args)

	export const permsCheck = RSel.memoizeFactory(
		<T extends RBAC.PermissionType>(req: RBAC.PermitChecker<T> | RBAC.PermitChecker<T>[] | RBAC.PermissionReq<T>) =>
			RSel.createDeepSelector([loggedInUser], (user) => RBAC.tryDenyPermissionsForRbacUser(user, req)),
	)

	export const loggedInUserPerms = RSel.createDeepSelector([loggedInUser], (user): RBAC.Permission[] =>
		RBAC.fromTracedPermissions(user.perms),
	)

	export const globalSettingsAccess = RSel.createDeepSelector([loggedInUserPerms], (perms): GlobalSettingsAccess => ({
		canRead: RBAC.canReadGlobalSettings(perms),
		write: RBAC.globalSettingsWriteAccess(perms),
	}))

	export const serverSettingsAccess = RSel.memoizeFactory((serverId: string) =>
		RSel.createDeepSelector([loggedInUserPerms], (perms): ServerSettingsAccess => ({
			canRead: RBAC.canReadServerSettings(perms, serverId),
			write: RBAC.serverSettingsWriteAccess(perms, serverId),
			sensitive: RBAC.canWriteSensitiveServerSettings(perms, serverId),
		})),
	)

	// the simulation switch on its own, so a consumer that only offers to turn it off doesn't re-render on every
	// role and permission toggled inside the permissions dialog
	export const simulateControls = RSel.createSelector(
		[(store: RbacStore) => store.simulate, (store: RbacStore) => store.setSimulate],
		(simulate, setSimulate) => ({ simulate, setSimulate }),
	)

	type SettingsLinkArgs = [user: RBAC.UserWithRbac, rbacStore: RbacStore, publicSettings: PublicSettings | undefined]

	// the Settings link is shown when the user can reach anything on that page: the server registry, the global
	// settings, or the settings of any one server
	export const settingsLinkVisible = RSel.createSelector(
		[(...[user, rbac]: SettingsLinkArgs) => loggedInUser(user, rbac), (...[, , settings]: SettingsLinkArgs) => settings?.servers],
		(user, servers) => {
			if (!RBAC.tryDenyPermissionsForRbacUser(user, SERVER_REGISTRY_REQ)) return true
			const perms = RBAC.fromTracedPermissions(user.perms)
			return RBAC.canReadGlobalSettings(perms) || (servers ?? []).some((server) => RBAC.canReadServerSettings(perms, server.id))
		},
	)

	// ------- the permissions dialog's views over the user's own (unsimulated) rbac -------

	type SimArgs = [user: RBAC.UserWithRbac | undefined, rbacStore: RbacStore]
	type RoleArgs = [user: RBAC.UserWithRbac | undefined, myRoles: RBAC.Role[] | undefined]
	type UnheldArgs = [allRoles: UserDefinedRole[] | undefined, myRoles: RBAC.Role[] | undefined]

	// every permission on offer: the user's own, plus the ones roles they've opted into would attribute to those roles.
	// Built from the base perms so that switching something off never removes the row carrying the control that switches
	// it back on
	export const shownPerms = RSel.createDeepSelector(
		[(...[user]: SimArgs) => user?.perms, (...[, rbac]: SimArgs) => rbac.simulate, (...[, rbac]: SimArgs) => rbac.addedRoles],
		(basePerms, simulate, addedRoles): RBAC.TracedPermission[] =>
			basePerms
				? UsersClient.simulatePerms(basePerms, { disabledRoles: [], addedRoles: simulate ? addedRoles : [], disabledPerms: [] })
				: [],
	)

	// the roles the user holds, each with the permissions it grants them. Roles come from myRoles rather than from the
	// permission traces, so that a role granting nothing still shows up as one they hold. The inferred roles
	// (filter-owner and friends) exist only in the traces, so both sources are merged
	export const heldRoles = RSel.createDeepSelector(
		[(...[user]: RoleArgs) => user?.perms, (...[, myRoles]: RoleArgs) => myRoles],
		(basePerms, myRoles) => {
			if (!basePerms) return []
			const byRole = new Map(RBAC.getPermissionsByRole(basePerms).map(([role, perms]) => [JSON.stringify(role), { role, perms }]))
			for (const role of myRoles ?? []) {
				const key = JSON.stringify(role)
				if (!byRole.has(key)) byRole.set(key, { role, perms: [] })
			}
			return [...byRole.values()]
		},
	)

	export const unheldRoles = RSel.createDeepSelector(
		[(...[allRoles]: UnheldArgs) => allRoles, (...[, myRoles]: UnheldArgs) => myRoles],
		(allRoles, myRoles) => {
			if (!allRoles || !myRoles) return []
			const held = new Set(myRoles.map((role) => role.type))
			return allRoles.filter((role) => !held.has(role.type))
		},
	)

	export const unheldPermTypes = RSel.createDeepSelector([(user: RBAC.UserWithRbac | undefined) => user?.perms], (basePerms) => {
		if (!basePerms) return []
		const held = new Set(basePerms.map((perm) => perm.type))
		return RBAC.PERMISSION_TYPE.options.filter((type) => !held.has(type))
	})
}
