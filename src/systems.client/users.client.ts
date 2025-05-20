import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as PartSys from '@/systems.client/parts'
import { reactQueryClient, trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import superjson from 'superjson'

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

export function useLoggedInUser() {
	return useQuery({
		...loggedInUserBaseQuery,
		staleTime: Infinity,
	})?.data
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
