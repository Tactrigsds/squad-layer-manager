import { trpcReact } from '@/lib/trpc.client'
import * as M from '@/models.ts'
import React from 'react'

export function useNowPlayingState() {
	const [nowPlaying, setNowPlaying] = React.useState<M.LayerSyncState>({ status: 'offline' })
	trpcReact.watchNowPlayingState.useSubscription(undefined, { onData: (d) => setNowPlaying(d) })
	return nowPlaying
}
