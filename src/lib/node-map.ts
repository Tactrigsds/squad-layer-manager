import * as Zus from 'zustand'
export const DEFAULT_NODE_ID = Symbol('defaultNodeId')

export type NodeId = string | symbol
export type NodeMapStore = {
	nodeMap: Map<NodeId, Element | undefined>
	setNode(id: NodeId, node: Element | undefined): void
}

export function initNodeMap(store: Zus.StoreApi<NodeMapStore>): NodeMapStore {
	return {
		nodeMap: new Map<NodeId, Element | undefined>(),
		setNode: (id: NodeId, node: Element | undefined) => {
			store.setState({ nodeMap: new Map(store.getState().nodeMap).set(id, node) })
		},
	}
}

export function useNode(id: NodeId, store: Zus.StoreApi<NodeMapStore>) {
	return Zus.useStore(store, (state) => state.nodeMap.get(id))
}
