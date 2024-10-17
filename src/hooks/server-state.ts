import type * as Squad from '@/lib/rcon/squad-models'
import { trpcReact } from '@/lib/trpc.client.ts'
import * as M from '@/models.ts'
import { useState } from 'react'
import React from 'react'

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
	const [nowPlaying, setNowPlaying] = React.useState<M.LayerSyncState>({ status: 'offline' })
	trpcReact.watchNowPlayingState.useSubscription(undefined, { onData: (d) => setNowPlaying(d) })
	return nowPlaying
}

export function useNextLayerState() {
	const [nextLayerState, setNextLayerState] = React.useState<M.LayerSyncState>({ status: 'offline' })
	trpcReact.watchNextLayerState.useSubscription(undefined, { onData: (d) => setNextLayerState(d) })
	return nextLayerState
}
