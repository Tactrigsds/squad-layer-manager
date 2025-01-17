import { type LayersQueryInput } from '@/server/systems/layer-queries'
import superjson from 'superjson'
import { trpc } from '@/lib/trpc.client'
import { useQuery } from '@tanstack/react-query'

export function useLayersQuery(input: LayersQueryInput, options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['getLayers', superjson.serialize(input)],
		placeholderData: (prev) => prev,
		queryFn: () => trpc.layers.selectLayers.query(input),
	})
}

export function useLayersGroupedBy(input: Parameters<typeof trpc.layers.selectLayersGroupedBy.query>[0], options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['getLayersGroupedBy', superjson.serialize(input)],
		queryFn: () => trpc.layers.selectLayersGroupedBy.query(input),
	})
}

export function useAreLayersInPool(input: Parameters<typeof trpc.layers.areLayersInPool.query>[0], options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['areLayersInPool', superjson.serialize(input)],
		queryFn: () => trpc.layers.areLayersInPool.query(input),
	})
}
