import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as SandboxFrame from '@/frames/sandbox.frame'
import React from 'react'

// Each sandbox window provisions its own frame rather than being handed one, so a pop-out does not die when the
// window that opened it closes. Frames are keyed by server, so the windows still read one another's edits.
export function useSandboxFrame(serverId: string): SandboxFrame.KeyProp {
	const input = React.useMemo(() => ({ serverId }), [serverId])
	const frameKey = useFrameLifecycle(SandboxFrame.frame, { input })
	useFrameTeardownOnUnmount(frameKey, true)
	return React.useMemo(() => ({ sandbox: frameKey }), [frameKey])
}
