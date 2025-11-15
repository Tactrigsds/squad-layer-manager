import * as NodeMap from '@/lib/node-map'
import React from 'react'
import { createPortal } from 'react-dom'
import type * as Zus from 'zustand'

export type NodeMapProps = {
	nodeId: NodeMap.NodeId
	store: Zus.StoreApi<NodeMap.NodeMapStore>
} & React.HTMLAttributes<HTMLDivElement>

const DEFAULT_NODE = document.body.appendChild(document.createElement('div'))
DEFAULT_NODE.id = '__node_map_default__'
DEFAULT_NODE.className = 'hidden'

const allocated = new Map<NodeMap.NodeId, Element>()

export function StoredParentNode(props: NodeMapProps) {
	const { store, nodeId, ...rest } = props
	const ref = React.useRef<HTMLDivElement>(null)

	React.useLayoutEffect(() => {
		store.getState().setNode(nodeId, ref.current ?? undefined)
	}, [nodeId, store])

	return <div ref={ref} {...rest} />
}

export function NodePortal(props: { nodeId: NodeMap.NodeId; store: Zus.StoreApi<NodeMap.NodeMapStore>; children: React.ReactNode }) {
	let node = NodeMap.useNode(props.nodeId, props.store)

	node ??= allocated.get(props.nodeId)
	if (!node) {
		node = document.createElement('div')
		node.classList.add(props.nodeId.toString())
		DEFAULT_NODE.appendChild(node)
		allocated.set(props.nodeId, node)
	}

	React.useEffect(() => {
		return () => {
			const node = allocated.get(props.nodeId)
			if (node) {
				DEFAULT_NODE.removeChild(node)
				allocated.delete(props.nodeId)
			}
		}
		 
	}, [props.nodeId])

	return createPortal(
		props.children,
		node,
	)
}
