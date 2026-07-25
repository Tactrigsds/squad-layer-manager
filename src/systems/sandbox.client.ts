import type * as SB from '@/models/sandbox.models'
import * as RPC from '@/orpc.client'
import { useMutation, useQuery } from '@tanstack/react-query'

// Which servers the session may drive as sandboxes. Empty for every install that has none, which is what gates
// the window being offered at all.
export function useSandboxServers() {
	return useQuery(RPC.orpc.sandbox.listSandboxServers.queryOptions())
}

export function useSandboxPlayers(serverId: string) {
	return useQuery(RPC.orpc.sandbox.listPlayers.queryOptions({ input: { serverId } }))
}

export function useExecuteMutation() {
	return useMutation(RPC.orpc.sandbox.execute.mutationOptions())
}

export function invalidatePlayers(serverId: string) {
	return RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.sandbox.listPlayers.queryKey({ input: { serverId } }) })
}

export type ExecuteResult = { verb: SB.SandboxVerb; ok: boolean; text: string }
