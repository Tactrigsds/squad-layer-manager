import { useState } from 'react'

import type * as Squad from '@/lib/rcon/squad-models'
import { trpcReact } from '@/lib/trpc.client.ts'
import * as M from '@/models.ts'

export function useSquadServerStatus() {
	const [serverStatus, setServerStatus] = useState<Squad.ServerStatus | null>(null)
	trpcReact.squadServer.watchServerStatus.useSubscription(undefined, {
		onData: (data) => {
			setServerStatus(data)
		},
	})
	return serverStatus
}

export type FilterMutationHandle = {
	onUpdate?: (update: M.UserEntityMutation<M.FilterEntity>) => void
}

// export function useFilterState(id: string, handle?: FilterMutationHandle) {
// 	trpcReact.filters.watchFilter.useSubscription(id, {
// 		onData: (e) => {
// 			if (e.code === 'initial-value') setFilterState(e.entity)
// 			if (e.code === 'update') {
// 				if (e.mutation.type !== 'delete') setFilterState(e.mutation.value)
// 				handle?.onUpdate?.(e.mutation)
// 			}
// 		},
// 	})
// }
