import * as React from 'react'
import { flushSync } from 'react-dom'

// useState that can also be set from outside the React tree, for state that is genuinely component-local but which
// the tutorial engine must be able to drive (a dialog's open flag, a tab choice). The component stays the owner;
// the handle is an actuation channel only -- observation goes through the DOM or a store, never through this.

const handles = new Map<string, Set<React.Dispatch<React.SetStateAction<any>>>>()

// `scope` distinguishes instances of the same hook mounted more than once (one dialog per queue item).
export function handleId(id: string, scope?: string | number): string {
	return scope === undefined ? id : `${id}:${scope}`
}

export function useState_withGlobalHandle<T>(id: string, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
	const [state, setState] = React.useState(initial)
	// layout effect, not effect: registration must be committed synchronously, so that code which mounts the owner
	// under flushSync can set the handle on its very next line
	React.useLayoutEffect(() => {
		let set = handles.get(id)
		if (!set) {
			set = new Set()
			handles.set(id, set)
		}
		set.add(setState)
		return () => {
			set.delete(setState)
			if (set.size === 0) handles.delete(id)
		}
	}, [id])
	return [state, setState]
}

// Set every mounted instance of the handle. Wrapped in flushSync so the render (and anything reading the DOM after
// this call) sees the new state synchronously; returns false when nothing is mounted, so a caller can fail loudly
// rather than no-op.
export function setGlobalHandle<T>(id: string, value: React.SetStateAction<T>): boolean {
	const set = handles.get(id)
	if (!set || set.size === 0) return false
	flushSync(() => {
		for (const dispatch of set) dispatch(value)
	})
	return true
}
