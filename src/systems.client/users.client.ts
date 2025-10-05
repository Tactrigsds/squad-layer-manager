import * as Obj from '@/lib/object'
import { fromTrpcSub } from '@/lib/trpc-helpers'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as PartSys from '@/systems.client/parts'
import * as RbacClient from '@/systems.client/rbac.client'
import { reactQueryClient, trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useQuery } from '@tanstack/react-query'

import * as React from 'react'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import * as Zus from 'zustand'

export let logggedInUserId: bigint | undefined

export function useUser(id?: bigint) {
	return useQuery({
		queryKey: ['getUser', superjson.serialize(id)],
		queryFn: async () => {
			return trpc.users.getUser.query(id!)
		},
		enabled: !!id,
	})
}

export function useUsers() {
	return useQuery({
		queryKey: ['getUsers'],
		queryFn: async () => trpc.users.getUsers.query(),
	})
}

async function _fetchLoggedInUser() {
	const user = await trpc.users.getLoggedInUser.query()
	PartSys.upsertParts({ users: [user] })
	logggedInUserId = user.discordId
	return user
}
const loggedInUserBaseQuery = {
	queryKey: ['getLoggedInUser'],
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
		const simulatedPerms = loggedInUser.perms.filter(p =>
			p.allowedByRoles.some(r => !disabledRoles.some(toCompare => Obj.deepEqual(r, toCompare)))
		)

		return {
			...loggedInUser,
			perms: RBAC.recalculateNegations(simulatedPerms),
		}
	}, [loggedInUser, simulateRoles, disabledRoles])
}

export async function fetchLoggedInUser() {
	return reactQueryClient.getQueryCache().build(reactQueryClient, {
		...loggedInUserBaseQuery,
	}).fetch()
}

export function invalidateLoggedInUser() {
	reactQueryClient.invalidateQueries(loggedInUserBaseQuery)
}

export function setup() {
	void reactQueryClient.prefetchQuery(loggedInUserBaseQuery)
	FilterEntityClient.filterMutation$.subscribe(async s => {
		const loggedInUser = await fetchLoggedInUser()
		if (!loggedInUser) return
		if (s.value.owner !== loggedInUser.discordId) return
		invalidateLoggedInUser()
	})
}

export const [useSteamAccountLinkCompleted, steamAccountLinkCompleted$] = ReactRx.bind<{ discordId: bigint }>(
	fromTrpcSub(undefined, trpc.users.watchSteamAccountLinkCompletion.subscribe).pipe(Rx.tap({
		next: () => {
			return invalidateLoggedInUser()
		},
	})),
)
