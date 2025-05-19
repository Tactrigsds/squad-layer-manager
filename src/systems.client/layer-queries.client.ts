import { sleep } from '@/lib/async'
import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models'
import { type LayersQueryInput } from '@/server/systems/layer-queries'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as PartsSys from '@/systems.client/parts'
import * as QD from '@/systems.client/queue-dashboard'
import { reactQueryClient, trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import deepEqual from 'fast-deep-equal'
import superjson from 'superjson'
import { z } from 'zod'
import * as Zus from 'zustand'

export function useLayersQuery(input: LayersQueryInput, options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayers', superjson.serialize(input)],
		placeholderData: (prev) => prev,
		queryFn: () => trpc.layers.queryLayers.query(input),
		staleTime: Infinity,
	})
}

export function useLayerComponents(input: Parameters<typeof trpc.layers.queryLayerComponents.query>[0], options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayerComponents', superjson.serialize(input)],
		queryFn: () => trpc.layers.queryLayerComponents.query(input),
		staleTime: Infinity,
	})
}
export function useSearchIds(input: Parameters<typeof trpc.layers.searchIds.query>[0], options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['layers', 'queryIds', superjson.serialize(input)],
		queryFn: () => trpc.layers.searchIds.query(input),
		staleTime: Infinity,
	})
}

export function useLayerStatuses(
	options?: { enabled?: boolean },
) {
	options ??= {}
	const editedQueue = Zus.useStore(QD.QDStore, s => s.editedServerState.layerQueue)
	const serverLayerQueue = Zus.useStore(QD.QDStore, s => s.serverState?.layerQueue)
	const editedPool = Zus.useStore(QD.QDStore, s => s.editedServerState.settings.queue.mainPool)
	const serverPool = Zus.useStore(QD.QDStore, s => s.serverState?.settings.queue.mainPool)
	return useQuery({
		...options,
		queryKey: [
			'layers',
			'getLayerStatusesForLayerQueue',
			superjson.serialize({ editedQueue, serverlayerQueue: serverLayerQueue, editedPool, serverPool }),
		],
		queryFn: async () => {
			if (serverLayerQueue && deepEqual(serverLayerQueue, editedQueue) && deepEqual(serverPool, editedPool)) {
				return PartsSys.getLayerStatuses()
			}

			return await trpc.layers.getLayerStatusesForLayerQueue.query({ queue: editedQueue, pool: editedPool })
		},
		staleTime: Infinity,
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
		queryKey: ['layers', 'layerExists', superjson.serialize(input)],
		queryFn: async () => {
			return await trpc.layers.layerExists.query(input)
		},
		staleTime: Infinity,
	})
}

export function setup() {
	FilterEntityClient.filterMutation$.subscribe((e) => {
		switch (e.type) {
			case 'add':
				break
			case 'update':
			case 'delete':
				invalidateLayerQueries()
				break
			default:
				assertNever(e.type)
		}
	})
}

export async function invalidateLayerQueries() {
	// low tech way to prevent all clients from spamming the server all at once
	await sleep(Math.random() * 2000)
	reactQueryClient.invalidateQueries({ queryKey: ['layers'] })
}
