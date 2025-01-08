import { trpc } from '@/lib/trpc.client'
import * as PartsSys from '@/systems.client/parts'
import { useQuery } from '@tanstack/react-query'

export function useLoggedInUser(options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['getLoggedInUser'],
		queryFn: async () => {
			const user = await trpc.getLoggedInUser.query()
			PartsSys.upsertParts({ users: [user] })
			return user
		},
	})
}
