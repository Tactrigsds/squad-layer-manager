import React from 'react'

export type DebouncedCommit<T> = {
	// replaces any pending value, and commits it after the delay
	schedule: (value: T) => void
	// commits the pending value now, if there is one
	flush: () => void
	// drops the pending value
	cancel: () => void
	isPending: () => boolean
}

// Batches an uncontrolled input's edits into commits. A pending value is committed after `delay`, on flush(), or on
// unmount, so wire flush() to blur and to any shortcut that reads the committed value.
export function useDebouncedCommit<T>(commit: (value: T) => void, delay: number): DebouncedCommit<T> {
	const commitRef = React.useRef(commit)
	React.useLayoutEffect(() => {
		commitRef.current = commit
	})
	const pendingRef = React.useRef<{ timeout: ReturnType<typeof setTimeout>; value: T } | null>(null)
	const [handle] = React.useState<DebouncedCommit<T>>(() => {
		const cancel = () => {
			if (pendingRef.current) clearTimeout(pendingRef.current.timeout)
			pendingRef.current = null
		}
		const flush = () => {
			const pending = pendingRef.current
			if (!pending) return
			cancel()
			commitRef.current(pending.value)
		}
		return {
			schedule: (value) => {
				cancel()
				pendingRef.current = { timeout: setTimeout(flush, delay), value }
			},
			flush,
			cancel,
			isPending: () => pendingRef.current !== null,
		}
	})
	React.useEffect(() => handle.flush, [handle])
	return handle
}
