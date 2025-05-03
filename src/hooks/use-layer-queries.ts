import * as M from '@/models'
import { type LayersQueryInput } from '@/server/systems/layer-queries'
import * as PartsSys from '@/systems.client/parts'
import * as QD from '@/systems.client/queue-dashboard'
import { trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import deepEqual from 'fast-deep-equal'
import superjson from 'superjson'
import * as Zus from 'zustand'

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

export function useLayerStatuses(
	options?: { enabled?: boolean },
) {
	options ??= {}
	const queue = Zus.useStore(QD.QDStore, s => s.editedServerState.layerQueue)
	const serverLayerQueue = Zus.useStore(QD.QDStore, s => s.serverState?.layerQueue)
	return useQuery({
		...options,
		queryKey: ['getLayerStatusesForLayerQueue', superjson.serialize({ queue, layerQueue: serverLayerQueue })],
		queryFn: async () => {
			// if (serverLayerQueue && deepEqual(serverLayerQueue, queue)) {
			// 	return PartsSys.getLayerStatuses()
			// }

			return await trpc.layers.getLayerStatusesForLayerQueue.query({ queue: queue })
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
