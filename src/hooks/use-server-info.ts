import { useState } from 'react'

import type * as SM from '@/lib/rcon/squad-models'
import { trpcReact } from '@/lib/trpc.client.ts'

export function useServerInfo() {
	const [serverInfo, setServerInfo] = useState<SM.ServerStatus | null>(null)
	trpcReact.pollServerInfo.useSubscription(undefined, {
		onData: (data) => {
			setServerInfo(data)
		},
	})
	return serverInfo
}
