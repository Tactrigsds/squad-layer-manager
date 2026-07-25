import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as ConsoleFrame from '@/frames/server-console.frame'
import React from 'react'

// Each console view provisions its own frame rather than being handed one, so the sandbox's embedded panel and a
// console window opened beside it do not depend on each other's lifetime. Frames are keyed by server, so both read
// the same tail.
export function useServerConsoleFrame(serverId: string): ConsoleFrame.KeyProp {
	const input = React.useMemo(() => ({ serverId }), [serverId])
	const frameKey = useFrameLifecycle(ConsoleFrame.frame, { input })
	useFrameTeardownOnUnmount(frameKey, true)
	return React.useMemo(() => ({ serverConsole: frameKey }), [frameKey])
}
