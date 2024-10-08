import { trpc } from '@/lib/trpc.client.ts'
import type * as Rcon from '@/server/systems/rcon'
import { useState } from 'react'

export function useServerInfo() {
	const [serverInfo, setServerInfo] = useState<Rcon.ServerStatus | null>(null)
	trpc.pollServerInfo.useSubscription(undefined, {
		onData: (data) => {
			setServerInfo(data)
		},
	})
	return serverInfo
}
