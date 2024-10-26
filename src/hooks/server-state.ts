import { useState } from 'react'
import React from 'react'

import type * as Squad from '@/lib/rcon/squad-models'
import { trpcReact } from '@/lib/trpc.client.ts'
import * as M from '@/models.ts'

export function useServerInfo() {
	const [serverInfo, setServerInfo] = useState<Squad.ServerStatus | null>(null)
	trpcReact.pollServerInfo.useSubscription(undefined, {
		onData: (data) => {
			setServerInfo(data)
		},
	})
	return serverInfo
}

export function useNowPlayingState() {
	const [nowPlaying, setNowPlaying] = React.useState<M.MiniLayer | null>(null)
	trpcReact.watchNowPlayingState.useSubscription(undefined, { onData: (d) => setNowPlaying(d) })
	return nowPlaying
}

export function useNextLayerState() {
	const [nextLayerState, setNextLayerState] = React.useState<M.MiniLayer | null>(null)
	trpcReact.watchNextLayerState.useSubscription(undefined, { onData: setNextLayerState })
	return nextLayerState
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
