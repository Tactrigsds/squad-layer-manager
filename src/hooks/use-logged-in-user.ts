import { trpc } from '@/lib/trpc.client'
import { useQuery } from '@tanstack/react-query'

export function useLoggedInUser(options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['getLoggedInUser'],
		queryFn: () => trpc.getLoggedInUser.query(),
	})
}
