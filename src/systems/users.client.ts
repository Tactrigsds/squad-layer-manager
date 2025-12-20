import * as Obj from '@/lib/object'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as PartSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import * as ReactRx from '@react-rxjs/core'
import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import * as Zus from 'zustand'

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

export function useUsers(userIds?: USR.UserId[], opts?: { enabled?: boolean }) {
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
	const { simulateRoles, disabledRoles } = Zus.useStore(RbacClient.RbacStore)
	const loggedInUser = useLoggedInUserBase()

	return React.useMemo(() => {
		if (!loggedInUser) return undefined

		if (!simulateRoles) return loggedInUser
		const simulatedPerms = loggedInUser.perms.filter((p: RBAC.TracedPermission) =>
			p.allowedByRoles.some((r) => !disabledRoles.some(toCompare => Obj.deepEqual(r, toCompare)))
		)

		return {
			...loggedInUser,
			perms: RBAC.recalculateNegations(simulatedPerms),
		}
	}, [loggedInUser, simulateRoles, disabledRoles])
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

const [_, userInvalidation$] = ReactRx.bind(RPC.observe(() => RPC.orpc.users.watchUserInvalidation.call()))

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

export const [useSteamAccountLinkCompleted, steamAccountLinkCompleted$] = ReactRx.bind<{ discordId: bigint }>(
	RPC.observe(() => RPC.orpc.users.watchSteamAccountLinkCompletion.call()).pipe(Rx.tap<{ discordId: bigint }>({
		next: () => {
			return invalidateLoggedInUser()
		},
	})),
)
