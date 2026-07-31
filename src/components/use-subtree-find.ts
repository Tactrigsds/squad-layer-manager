import React from 'react'

import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as FindFrame from '@/frames/subtree-find.frame'

export type SubtreeFind = {
	stores: FindFrame.KeyProp
	/** Attach to the element whose text is searchable, for callers not already holding a ref to it. */
	scopeRef: (el: HTMLElement | null) => void
}

/**
 * Provisions a find session over one subtree, for `SubtreeFindBar` to drive. Pass a ref to the element to search,
 * or leave it out and use the returned `scopeRef`.
 */
export function useSubtreeFind(scope?: React.RefObject<HTMLElement | null>): SubtreeFind {
	const instanceId = React.useId()
	const frameKey = useFrameLifecycle(FindFrame.frame, { input: { instanceId } })
	useFrameTeardownOnUnmount(frameKey)
	const stores = React.useMemo(() => ({ subtreeFind: frameKey }), [frameKey])

	// a ref object cannot announce that it has been filled in, so the scope is re-read after every render. attach
	// returns immediately when the element is the one already being searched, which it is on all but the first.
	React.useEffect(() => {
		if (scope) FindFrame.Actions.attach(stores, scope.current)
	})

	React.useEffect(() => {
		if (!scope) return
		return () => FindFrame.Actions.attach(stores, null)
	}, [scope, stores])

	const scopeRef = React.useCallback(
		(el: HTMLElement | null) => {
			FindFrame.Actions.attach(stores, el)
			return () => FindFrame.Actions.attach(stores, null)
		},
		[stores],
	)

	return { stores, scopeRef }
}
