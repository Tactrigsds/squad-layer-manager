import { type LayersQueryInput } from '@/server/systems/layer-queries'
import superjson from 'superjson'
import * as M from '@/models'
import { trpc } from '@/lib/trpc.client'
import * as PartsSys from '@/systems.client/parts'
import { useQuery } from '@tanstack/react-query'
import { assertNever } from '@/lib/typeGuards'

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

			const results: { id: M.LayerId; matchesFilter: boolean }[] = []
			if (input.poolFilterId) {
				allFound = true
				for (const layerId of input.layers) {
					const status = PartsSys.findLayerState(input.poolFilterId, layerId)
					if (status) {
						results.push({ id: layerId, matchesFilter: status.inPool })
					} else {
						allFound = false
					}
				}
				if (allFound) return { code: 'ok' as const, results }
			}

			const res = await trpc.layers.areLayersInPool.query(input)

			switch (res.code) {
				case 'err:pool-filter-not-set':
					return { code: 'err:pool-filter-not-set' as const }
				case 'ok': {
					for (const item of res.results) {
						if (!results.find((r) => r.id === item.id)) {
							results.push(item)
						}
					}
					return { code: 'ok' as const, results }
				}
				default:
					assertNever(res)
			}
		},
	})
}
