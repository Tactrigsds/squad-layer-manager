import { trpc, reactQueryClient } from '@/lib/trpc.client'
import * as M from '@/models'
import * as PartSys from '@/systems.client/parts'
import { useQuery } from '@tanstack/react-query'

// const loggedInUserSubject$ = new Subject<(M.UserWithRbac & C.WSSession) | null>()
async function _fetchLoggedInUser() {
	const user = await trpc.users.getLoggedInUser.query()
	PartSys.upsertParts({ users: [user] })
	return user
}

const options = {
	queryKey: ['getLoggedInUser'],
	queryFn: _fetchLoggedInUser,
}
export function useLoggedInUser() {
	return useQuery(options)?.data
}

export async function fetchLoggedInUser() {
	return reactQueryClient.getQueryCache().build(reactQueryClient, options).fetch()
}

export function invalidateLoggedInUser() {
	reactQueryClient.invalidateQueries({ queryKey: options.queryKey })
}
