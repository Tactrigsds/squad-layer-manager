import type * as FRM from '@/lib/frame'
import * as Zus from '@/lib/zustand'
import type * as SM from '@/models/squad.models'
import type * as SRQ from '@/models/switch-requests.models'
import * as RPC from '@/orpc.client'

export type Store = {
	switchRequests: SwitchRequestsSlice
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { switchRequests: Key }

// server-authoritative: the slice mirrors the server's queue and never edits it locally
export type SwitchRequestsSlice = {
	serverId: string
	requests: SRQ.SwitchRequest[]
	// players with a forced switch in flight
	swapping: SM.PlayerId[]
}

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store>

export function initSwitchRequests(args: Args) {
	const set = Zus.toPartialSetter(args.set, 'switchRequests')
	const serverId = args.input.serverId

	set({ serverId, requests: [], swapping: [] } satisfies SwitchRequestsSlice)

	args.cleanup.push(
		RPC.observe('switchRequests.watchUpdates', () => RPC.orpc.switchRequests.watchUpdates.call({ serverId }))
			.pipe(RPC.dropServerNotLoaded())
			.subscribe((update) => {
				set({ requests: update.requests, swapping: update.swapping })
			}),
	)
}
