import type * as Squad from '@/lib/rcon/squad-models'
import { trpc } from '@/lib/trpc.client.ts'
import * as M from '@/models.ts'
import React from 'react'
import { atom, getDefaultStore, useAtomValue } from 'jotai'

const serverStatusAtom = atom<Squad.ServerStatus | null>(null)

export function useSquadServerStatus() {
	// TODO this is cringe but the type definitions of trpc-jotai are broken
	React.useEffect(() => {
		const sub = trpc.squadServer.watchServerStatus.subscribe(undefined, {
			onData: (data) => {
				const store = getDefaultStore()
				store.set(serverStatusAtom, data)
			},
		})
		return () => {
			return sub.unsubscribe()
		}
	}, [])
	const serverStatus = useAtomValue(serverStatusAtom, { store: getDefaultStore() })
	return serverStatus
}

export type FilterMutationHandle = {
	onUpdate?: (update: M.UserEntityMutation<M.FilterEntity>) => void
}
