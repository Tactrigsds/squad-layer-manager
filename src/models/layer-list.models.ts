import { z } from 'zod'
import { createId } from '../lib/id'
import * as L from './layer'
import * as V from './vote.models'

export const LayerSourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('generated') }),
	z.object({ type: z.literal('gameserver') }),
	z.object({ type: z.literal('unknown') }),
	z.object({ type: z.literal('manual'), userId: z.bigint() }),
])

export type LayerSource = z.infer<typeof LayerSourceSchema>
export const LayerListItemSchema = z.object({
	itemId: z.string().regex(/^[a-zA-Z0-9_-]{6,24}$/),
	layerId: L.LayerIdSchema.optional(),
	vote: V.LayerVoteSchema.optional(),
	source: LayerSourceSchema,
})

export const LayerListSchema = z.array(LayerListItemSchema)

export type LayerList = z.infer<typeof LayerListSchema>
export type LayerListItem = z.infer<typeof LayerListItemSchema>
export type NewLayerListItem = Omit<LayerListItem, 'itemId'>

export function getActiveItemLayerId(item: LayerListItem) {
	return item.layerId ?? item.vote!.choices[0]
}
export function createLayerListItem(newItem: NewLayerListItem): LayerListItem {
	return {
		...newItem,
		itemId: createId(24),
	}
}

export function getNextLayerId(layerQueue: LayerList) {
	if (layerQueue.length === 0) return
	return getLayerIdToSetFromItem(layerQueue[0])
}

export function getLayerIdToSetFromItem(item: LayerListItem) {
	return item.layerId ?? item.vote?.defaultChoice
}

export function getAllItemLayerIds(item: LayerListItem, opts?: { excludeVoteChoices?: boolean }) {
	const ids = new Set<L.LayerId>()
	if (item.layerId) {
		ids.add(item.layerId)
	}

	if (item.vote && !opts?.excludeVoteChoices) {
		for (const choice of item.vote.choices) ids.add(choice)
	}
	return ids
}

export function getAllLayerIdsFromList(layerList: LayerList, opts?: { excludeVoteChoices?: boolean }) {
	const layerIds = new Set<L.LayerId>()
	// using list instead of set to preserve ordering
	for (const set of layerList.map(item => getAllItemLayerIds(item, { excludeVoteChoices: opts?.excludeVoteChoices }))) {
		for (const id of set) layerIds.add(id)
	}
	return Array.from(layerIds)
}

export function toQueueLayerKey(itemId: string, choice?: string) {
	let id = itemId
	if (choice) id += `:${choice}`
	return id
}

export function parseQueueLayerKey(key: string) {
	const [itemId, choice] = key.split(':')
	return [itemId, choice]
}

export function getAllLayerIdsWithQueueKey(item: LayerListItem) {
	const tuples: [string, L.LayerId][] = []
	if (item.layerId) tuples.push([toQueueLayerKey(item.itemId), item.layerId])
	if (item.vote) {
		for (const choice of item.vote.choices) {
			tuples.push([item.itemId, choice])
		}
	}
	return tuples
}

export function getIndexOfQueueKey(queue: LayerList, key: string) {
	for (let i = 0; i < queue.length; i++) {
		if (toQueueLayerKey(queue[i].itemId, queue[i].vote?.choices[0]) === key) {
			return i
		}
	}
	return -1
}

export function getAllLayerQueueKeysWithLayerId(layerId: L.LayerId, queue: LayerList) {
	const keys = new Set<string>()
	for (const item of queue) {
		if (item.layerId === layerId) {
			keys.add(toQueueLayerKey(item.itemId))
		}
		if (item.vote) {
			for (const choice of item.vote.choices) {
				keys.add(toQueueLayerKey(item.itemId, choice))
			}
		}
	}
	return keys
}
