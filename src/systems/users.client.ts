import * as Obj from '@/lib/object'
import * as RxHelpers from '@/lib/react-rxjs-helpers'
import * as ZusUtils from '@/lib/zustand'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as PartSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as React from 'react'
import superjson from 'superjson'

export let loggedInUserId: bigint | undefined
export let loggedInUser: USR.User | undefined

export function getFetchUserOptions(id?: bigint, opts?: { enabled?: boolean }) {
	return {
		queryKey: ['users', 'getUser', superjson.serialize(id)],
		queryFn: async () => {
			return RPC.orpc.users.getUser.call(id!)
		},
		enabled: !!id && opts?.enabled !== false,
	}
}

export function useUser(id?: bigint, opts?: { enabled?: boolean }) {
	return useQuery(getFetchUserOptions(id, opts))
}

export function useUsers(_userIds?: USR.UserId[] | Set<USR.UserId>, opts?: { enabled?: boolean }) {
	const userIds = _userIds instanceof Set ? [..._userIds.values()] : _userIds
	return useQuery({
		queryKey: ['users', 'getUsers', superjson.serialize(userIds)],
		enabled: opts?.enabled,
		queryFn: async () => RPC.orpc.users.getUsers.call(userIds),
	})
}

async function _fetchLoggedInUser() {
	const user = await RPC.orpc.users.getLoggedInUser.call()
	PartSys.upsertParts({ users: [user] })
	loggedInUserId = user.discordId
	loggedInUser = user
	return user
}
const loggedInUserBaseQuery = {
	queryKey: ['users', 'getLoggedInUser'],
	queryFn: _fetchLoggedInUser,
}

export function useLoggedInUserBase() {
	return useQuery({
		...loggedInUserBaseQuery,
		staleTime: Infinity,
	})?.data
}

// NOTE: this method of simulating perms will not work with actions that aren't validated client-side.
export function useLoggedInUser() {
	const { simulate, disabledRoles, addedRoles, disabledPerms } = ZusUtils.useStore(RbacClient.RbacStore)
	const loggedInUser = useLoggedInUserBase()

	return React.useMemo(() => {
		if (!loggedInUser) return undefined
		if (!simulate) return loggedInUser

		return {
			...loggedInUser,
			perms: RBAC.recalculateNegations(
				simulatePerms(loggedInUser.perms, { disabledRoles, addedRoles, disabledPerms }),
			),
		}
	}, [loggedInUser, simulate, disabledRoles, addedRoles, disabledPerms])
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
	const res = await RPC.queryClient.getQueryCache().build(RPC.queryClient, getFetchUserOptions(id)).fetch()
	return res?.code === 'ok' ? res.user.displayName : fallback
}

export async function fetchLoggedInUser() {
	return RPC.queryClient.getQueryCache().build(RPC.queryClient, {
		...loggedInUserBaseQuery,
	}).fetch()
}

export function invalidateLoggedInUser() {
	void RPC.queryClient.invalidateQueries(loggedInUserBaseQuery)
}

export function invalidateUsers() {
	void RPC.queryClient.invalidateQueries({ queryKey: ['users'] })
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
	void RPC.queryClient.prefetchQuery(loggedInUserBaseQuery)
	FilterEntityClient.filterMutation$.subscribe(async s => {
		const loggedInUser = await fetchLoggedInUser()
		if (!loggedInUser) return
		if (s.value.owner !== loggedInUser.discordId) return
		invalidateLoggedInUser()
	})
}

const myLinkedSteamAccountsQuery = {
	queryKey: ['users', 'getMyLinkedSteamAccounts'],
	queryFn: async () => RPC.orpc.users.getMyLinkedSteamAccounts.call(),
}

export function useMyLinkedSteamAccounts() {
	return useQuery(myLinkedSteamAccountsQuery)
}

export function useUpdateLinkedSteamAccountsMutation() {
	return useMutation({
		...RPC.orpc.users.updateLinkedSteamAccounts.mutationOptions(),
		onSuccess: (res) => {
			if (res.code === 'ok') void RPC.queryClient.invalidateQueries({ queryKey: myLinkedSteamAccountsQuery.queryKey })
		},
	})
}
