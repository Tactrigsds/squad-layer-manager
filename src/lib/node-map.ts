import * as Zus from '@/lib/zustand'
export const DEFAULT_NODE_ID = Symbol('defaultNodeId')

export type NodeId = string | symbol
export type NodeMapStore = {
	nodeMap: Map<NodeId, Element | undefined>
	setNode(id: NodeId, node: Element | undefined): void
}

export function initNodeMap(get: Zus.Getter<NodeMapStore>, set: Zus.Setter<NodeMapStore>): NodeMapStore {
	return {
		nodeMap: new Map<NodeId, Element | undefined>(),
		setNode: (id: NodeId, node: Element | undefined) => {
			set({ nodeMap: new Map(get().nodeMap).set(id, node) })
		},
	}
}

export function useNode(id: NodeId, store: Zus.StoreApi<NodeMapStore>) {
	return Zus.useStore(store, (state) => state.nodeMap.get(id))
}
