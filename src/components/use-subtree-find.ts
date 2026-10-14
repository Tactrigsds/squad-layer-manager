import React from 'react'

import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as FindFrame from '@/frames/subtree-find.frame'
import * as KBClient from '@/systems/keybinds.client'

export type SubtreeFind = {
	stores: FindFrame.KeyProp
	/** Attach to the element whose text is searchable, for callers not already holding a ref to it. */
	scopeRef: (el: HTMLElement | null) => void
}

/**
 * Provisions a find session over one subtree, for `SubtreeFindBar` to drive. Pass a ref to the element to search,
 * or leave it out and use the returned `scopeRef`. The subtree is a `find-region` keybinding scope, so the find key
 * opens the bar while focus is inside it, or with nothing focused while the pointer is over it, and the browser's own
 * find answers everywhere else.
 */
export function useSubtreeFind(scope?: React.RefObject<HTMLElement | null>): SubtreeFind {
	const instanceId = React.useId()
	const frameKey = useFrameLifecycle(FindFrame.frame, { input: { instanceId } })
	useFrameTeardownOnUnmount(frameKey)
	const stores = React.useMemo(() => ({ subtreeFind: frameKey }), [frameKey])
	const kbScope = KBClient.useScope('find-region', { 'find-in-region': () => FindFrame.Actions.requestInput(stores) })

	// a ref object cannot announce that it has been filled in, so the scope is re-read after every render. attach
	// returns immediately when the element is the one already being searched, which it is on all but the first.
	// the element searched and keyed, and how to let go of its keys
	const attached = React.useRef<{ element: HTMLElement | null; detachKeys?: () => void }>({ element: null })
	const attachTo = React.useCallback(
		(element: HTMLElement | null) => {
			if (attached.current.element === element) return
			attached.current.detachKeys?.()
			FindFrame.Actions.attach(stores, element)
			attached.current = { element, detachKeys: kbScope.ref(element) }
		},
		[stores, kbScope],
	)

	// a ref object cannot announce that it has been filled in, so the scope is re-read after every render. attachTo
	// returns immediately when the element is the one already attached, which it is on all but the first.
	React.useEffect(() => {
		if (scope) attachTo(scope.current)
	})

	React.useEffect(() => () => attachTo(null), [attachTo])

	const scopeRef = React.useCallback(
		(el: HTMLElement | null) => {
			attachTo(el)
			return () => attachTo(null)
		},
		[attachTo],
	)

	return { stores, scopeRef }
}
