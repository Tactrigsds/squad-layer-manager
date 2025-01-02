import type * as Squad from '@/lib/rcon/squad-models'
import { trpc } from '@/lib/trpc.client.ts'
import * as M from '@/models.ts'
import React from 'react'

export function useSquadServerStatus() {
	const [serverStatus, setServerStatus] = React.useState<Squad.ServerStatus | null>(null)
	React.useEffect(() => {
		const sub = trpc.squadServer.watchServerStatus.subscribe(undefined, {
			onData: (data) => {
				setServerStatus(data)
			},
		})
		return () => sub.unsubscribe()
	}, [])
	return serverStatus
}

export type FilterMutationHandle = {
	onUpdate?: (update: M.UserEntityMutation<M.FilterEntity>) => void
}
