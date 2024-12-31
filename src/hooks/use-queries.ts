import { type LayersQueryInput } from '@/server/systems/layers-query.ts'
import superjson from 'superjson'
import { trpc } from '@/lib/trpc.client'
import { queryOptions, useQuery } from '@tanstack/react-query'

export function useLayersQuery(input: LayersQueryInput, options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['getLayers', superjson.serialize(input)],
		queryFn: () => trpc.getLayers.query(input),
	})
}
