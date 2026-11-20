import * as TSR from '@tanstack/react-router'

/**
 * Asks before a navigation to another page while `unsaved()` holds, and before the tab closes while
 * `enableBeforeUnload` holds. A navigation that stays on the page passes without asking, such as a change of search
 * param or hash.
 */
export function useBlocker(opts: { enableBeforeUnload: boolean; unsaved: () => boolean; message: () => string }) {
	TSR.useBlocker({
		enableBeforeUnload: opts.enableBeforeUnload,
		shouldBlockFn: ({ current, next }) => {
			if (current.pathname === next.pathname) return false
			if (!opts.unsaved()) return false
			return !confirm(opts.message())
		},
	})
}
