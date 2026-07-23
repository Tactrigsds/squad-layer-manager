import * as Obj from '@/lib/object'
import * as RxHelpers from '@/lib/react-rxjs-helpers'
import * as RSel from '@/lib/reselect'
import * as ZusUtils from '@/lib/zustand'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as PartSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'

export let loggedInUserId: bigint | undefined
export let loggedInUser: USR.User | undefined

export function userQueryOptions(id?: USR.UserId, opts?: { enabled?: boolean }) {
	return RPC.orpc.users.getUser.queryOptions({
		input: id ?? skipToken,
		enabled: id !== undefined && opts?.enabled !== false,
	})
}

export function useUser(id?: USR.UserId, opts?: { enabled?: boolean }) {
	return useQuery(userQueryOptions(id, opts))
}

export function usersQueryOptions(userIds?: USR.UserId[] | Set<USR.UserId>, opts?: { enabled?: boolean }) {
	return RPC.orpc.users.getUsers.queryOptions({
		input: userIds instanceof Set ? [...userIds.values()] : userIds,
		enabled: opts?.enabled,
	})
}

export function useUsers(userIds?: USR.UserId[] | Set<USR.UserId>, opts?: { enabled?: boolean }) {
	return useQuery(usersQueryOptions(userIds, opts))
}

export const loggedInUserQueryOptions = RPC.orpc.users.getLoggedInUser.queryOptions({
	queryFn: async () => {
		const user = await RPC.orpc.users.getLoggedInUser.call()
		PartSys.upsertParts({ users: [user] })
		loggedInUserId = user.discordId
		loggedInUser = user
		return user
	},
	staleTime: Infinity,
})

export function useLoggedInUserBase() {
	return useQuery(loggedInUserQueryOptions)?.data
}

// NOTE: this method of simulating perms will not work with actions that aren't validated client-side.
export function useLoggedInUser() {
	return ZusUtils.useStore(loggedInUserQueryOptions, RbacClient.RbacStore, Sel.maybeLoggedInUser)
}

// suspends until the logged-in user is loaded instead of returning undefined
export function useSuspendableLoggedInUser() {
	return ZusUtils.useStore_Susp(loggedInUserQueryOptions, RbacClient.RbacStore, Sel.loggedInUser)
}

export type Simulation = {
	disabledRoles: RBAC.Role[]
	addedRoles: RbacClient.SimulatableRole[]
	disabledPerms: RBAC.Permission[]
}

// the perms a simulation leaves the user with, before negations are recalculated. Added roles contribute perms the user
// already holds, so the only thing they change on their own is which roles a perm is attributed to.
export function simulatePerms(basePerms: RBAC.TracedPermission[], simulation: Simulation): RBAC.TracedPermission[] {
	const isRoleDisabled = (role: RBAC.Role) => simulation.disabledRoles.some(disabled => Obj.deepEqual(role, disabled))

	const perms: RBAC.TracedPermission[] = basePerms.map(p => ({ ...p, allowedByRoles: [...p.allowedByRoles] }))
	for (const added of simulation.addedRoles) {
		if (isRoleDisabled(added.role)) continue
		for (const perm of added.perms) {
			RBAC.addTracedPerms(perms, { ...perm, allowedByRoles: [...perm.allowedByRoles] })
		}
	}

	return perms.filter(p =>
		p.allowedByRoles.some(role => !isRoleDisabled(role))
		&& !simulation.disabledPerms.some(disabled => RBAC.isSamePerm(disabled, p))
	)
}

// resolves a user id to the name to show, outside of a hook (e.g. from a toast in an rx subscription). Shares the
// cache with useUser, so an already-loaded user costs nothing.
export async function fetchDisplayName(id: USR.UserId, fallback = 'another user') {
	const cached = PartSys.findUser(id)
	if (cached) return cached.displayName
	const res = await RPC.queryClient.fetchQuery(userQueryOptions(id))
	return res?.code === 'ok' ? res.user.displayName : fallback
}

export async function fetchLoggedInUser() {
	return RPC.queryClient.fetchQuery(loggedInUserQueryOptions)
}

export function invalidateLoggedInUser() {
	void RPC.queryClient.invalidateQueries({ queryKey: loggedInUserQueryOptions.queryKey })
}

export function invalidateUsers() {
	void RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.users.key() })
	PartSys.PartsStore.setState({ users: [] })
}

// an event feed, not state: it stays silent until something actually invalidates, so it must not be given a
// first-emit guard (which would error the stream out of existence 15s after connecting)
const [_, userInvalidation$] = RxHelpers.bind(
	'users.userInvalidation',
	RPC.observe('users.watchUserInvalidation', () => RPC.orpc.users.watchUserInvalidation.call()),
	{ firstEmitTimeoutMs: false },
)

export function setup() {
	userInvalidation$.subscribe(() => {
		invalidateUsers()
	})
	// every suspending perms hook hangs on this one, so it starts before the first render rather than with it
	void RPC.queryClient.prefetchQuery(loggedInUserQueryOptions)
	void RPC.queryClient.prefetchQuery(RPC.orpc.users.getMyLinkedSteamAccounts.queryOptions())
	FilterEntityClient.filterMutation$.subscribe(async s => {
		const loggedInUser = await fetchLoggedInUser()
		if (!loggedInUser) return
		if (s.value.owner !== loggedInUser.discordId) return
		invalidateLoggedInUser()
	})
}

export function useMyLinkedSteamAccounts() {
	return useQuery(RPC.orpc.users.getMyLinkedSteamAccounts.queryOptions())
}

export function useUpdateLinkedSteamAccountsMutation() {
	return useMutation(RPC.orpc.users.updateLinkedSteamAccounts.mutationOptions({
		onSuccess: (res) => {
			if (res.code === 'ok') void RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.users.getMyLinkedSteamAccounts.key() })
		},
	}))
}

export namespace Sel {
	type Args = [user: RBAC.UserWithRbac, rbacStore: RbacClient.RbacStore]
	type MaybeArgs = [user: RBAC.UserWithRbac | undefined, rbacStore: RbacClient.RbacStore]

	export const loggedInUser = RSel.createSelector(
		[
			(user: RBAC.UserWithRbac) => user,
			(...[, rbac]: Args) => rbac.simulate,
			(...[, rbac]: Args) => rbac.disabledRoles,
			(...[, rbac]: Args) => rbac.addedRoles,
			(...[, rbac]: Args) => rbac.disabledPerms,
		],
		(user, simulate, disabledRoles, addedRoles, disabledPerms): RBAC.UserWithRbac => {
			if (!simulate) return user
			return {
				...user,
				perms: RBAC.recalculateNegations(simulatePerms(user.perms, { disabledRoles, addedRoles, disabledPerms })),
			}
		},
	)

	export function maybeLoggedInUser(...[user, rbacStore]: MaybeArgs) {
		return user && loggedInUser(user, rbacStore)
	}
}
