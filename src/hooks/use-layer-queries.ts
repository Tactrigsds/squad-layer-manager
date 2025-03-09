import * as M from '@/models'
import { type LayersQueryInput } from '@/server/systems/layer-queries'
import * as PartsSys from '@/systems.client/parts'
import { trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import superjson from 'superjson'

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
		queryFn: async () => {
			let allFound = false

			const results: { id: M.LayerId; matchesFilter: boolean; exists: boolean }[] = []
			if (input.poolFilterId) {
				allFound = true
				for (const layerId of input.layers) {
					const status = PartsSys.findLayerState(input.poolFilterId, layerId)
					if (status) {
						results.push({ id: layerId, matchesFilter: status.inPool, exists: status.exists })
					} else {
						allFound = false
					}
				}
				if (allFound) return { code: 'ok' as const, results }
			}

			const res = await trpc.layers.areLayersInPool.query(input)

			if (res.code !== 'ok') return res

			for (const item of res.results) {
				if (!results.find((r) => r.id === item.id)) {
					results.push(item)
				}
			}
			return { code: 'ok' as const, results }
		},
	})
}

export function useLayerExists(
	input: Parameters<typeof trpc.layers.layerExists.query>[0],
	options?: { enabled?: boolean; usePlaceholderData?: boolean },
) {
	options ??= {}
	return useQuery({
		...options,
		placeholderData: options?.usePlaceholderData ? (d) => d : undefined,
		queryKey: ['layerExists', superjson.serialize(input)],
		queryFn: async () => {
			return await trpc.layers.layerExists.query(input)
		},
	})
}
