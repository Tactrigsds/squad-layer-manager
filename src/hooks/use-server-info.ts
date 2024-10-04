import { trpc } from '@/lib/trpc'
import * as M from '@/models'
import { useState } from 'react'

export function useServerInfo() {
	const [serverInfo, setServerInfo] = useState<M.ServerStatus | null>(null)
	trpc.pollServerInfo.useSubscription(undefined, {
		onData: (data) => {
			setServerInfo(data)
		},
	})
	return serverInfo
}
