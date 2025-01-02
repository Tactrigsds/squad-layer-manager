import { type LayersQueryInput } from '@/server/systems/layers-query.ts'
import superjson from 'superjson'
import { trpc } from '@/lib/trpc.client'
import { useQuery } from '@tanstack/react-query'

export function useLayersQuery(input: LayersQueryInput, options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['getLayers', superjson.serialize(input)],
		queryFn: () => trpc.getLayers.query(input),
	})
}

export function useLayersGroupedBy(input: Parameters<typeof trpc.getLayersGroupedBy.query>[0], options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['getLayersGroupedBy', superjson.serialize(input)],
		queryFn: () => trpc.getLayersGroupedBy.query(input),
	})
}
