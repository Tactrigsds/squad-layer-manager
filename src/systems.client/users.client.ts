import { useQuery } from '@tanstack/react-query'
import { trpc } from '@/lib/trpc.client'
import superjson from 'superjson'

export function useUser(id?: bigint) {
	return useQuery({
		queryKey: ['getUser', superjson.serialize(id)],
		queryFn: async () => {
			return trpc.users.getUser.query(id!)
		},
		enabled: !!id,
	})
}

export const GET_USERS_QUERY_KEY = ['getUsers']
export function useUsers() {
	return useQuery({
		queryKey: GET_USERS_QUERY_KEY,
		queryFn: async () => trpc.users.getUsers.query(),
	})
}
