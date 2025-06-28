import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as PartSys from '@/systems.client/parts'
import * as RbacClient from '@/systems.client/rbac.client'
import { reactQueryClient, trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import deepEqual from 'fast-deep-equal'
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
	if (!loggedInUser) return undefined

	if (!simulateRoles) return loggedInUser
	const simulatedPerms = loggedInUser.perms.filter(p =>
		p.allowedByRoles.some(r => !disabledRoles.some(toCompare => deepEqual(r, toCompare)))
	)

	return {
		...loggedInUser,
		perms: RBAC.recalculateNegations(simulatedPerms),
	}
}

export async function fetchLoggedInUser() {
	return reactQueryClient.getQueryCache().build(reactQueryClient, {
		...loggedInUserBaseQuery,
	}).fetch()
}

export function invalidateLoggedInUser() {
	reactQueryClient.invalidateQueries({
		queryKey: ['getLoggedInUser'],
	})
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
