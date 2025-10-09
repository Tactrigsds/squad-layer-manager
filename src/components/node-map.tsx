import * as NodeMap from '@/lib/node-map'
import React from 'react'
import { createPortal } from 'react-dom'
import * as Zus from 'zustand'

export type NodeMapProps = {
	nodeId: NodeMap.NodeId
	store: Zus.StoreApi<NodeMap.NodeMapStore>
} & React.HTMLAttributes<HTMLDivElement>

export function StoredNodeProvider(props: { children: React.ReactNode; store: Zus.StoreApi<NodeMap.NodeMapStore> }) {
	return (
		<>
			<StoredParentNode nodeId={NodeMap.DEFAULT_NODE_ID} store={props.store} className="hidden" />
			{props.children}
		</>
	)
}

export function StoredParentNode(props: NodeMapProps) {
	const { store, nodeId, ...rest } = props
	const ref = React.useRef<HTMLDivElement>(null)

	React.useEffect(() => {
		store.getState().setNode(nodeId, ref.current ?? undefined)
	}, [nodeId, store])

	return <div ref={ref} {...rest} />
}

export function NodePortal(props: { nodeId: NodeMap.NodeId; store: Zus.StoreApi<NodeMap.NodeMapStore>; children: React.ReactNode }) {
	const node = NodeMap.useNode(props.nodeId, props.store)

	return createPortal(
		props.children,
		node,
	)
}
