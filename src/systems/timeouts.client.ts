import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as UsersClient from '@/systems/users.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'

export const [useActiveTimeouts, activeTimeouts$] = ReactRx.bind(
	RPC.observe(() => RPC.orpc.timeouts.watchActiveTimeouts.call()),
	[],
)

export function useKickPlayerMutation() {
	return useMutation(RPC.orpc.timeouts.kickPlayer.mutationOptions())
}

export function useCancelTimeoutMutation() {
	return useMutation(RPC.orpc.timeouts.cancelTimeout.mutationOptions())
}

// the logged-in user's effective max kick-timeout: undefined = cannot issue timeouts, null = unlimited,
// number = max ms. Timeout grants are comparator-matched, so RbacClient.usePermsCheck (equality) can't gate this.
export function useMaxTimeout(): number | null | undefined {
	const user = UsersClient.useLoggedInUser()
	if (!user) return undefined
	return RBAC.maxTimeoutDurationMs(RBAC.fromTracedPermissions(user.perms))
}
