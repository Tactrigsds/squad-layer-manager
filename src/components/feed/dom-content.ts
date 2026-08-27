import React from 'react'

import * as Dom from '@/lib/dom'

/**
 * Mounts built dom inside a react-rendered host element.
 *
 * This is how a react component becomes a wrapper over a dom builder rather than a second copy of it: react owns
 * the host and its props, the builder owns everything inside. The host is usually `display:contents`, so what the
 * builder made is what the layout sees.
 */
export function useDomContent<T extends Element>(node: Dom.Child, forwarded?: React.Ref<T>): React.RefObject<T | null> {
	const host = React.useRef<T | null>(null)
	// the sanctioned way to write through a forwarded ref, rather than composing one by hand
	React.useImperativeHandle(forwarded, () => host.current as T, [])

	React.useLayoutEffect(() => {
		if (host.current) host.current.replaceChildren(Dom.frag(node))
	}, [node])

	return host
}
