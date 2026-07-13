import { toast } from '@/lib/toast'
import * as ZodLib from '@/lib/zod'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as UsersClient from '@/systems/users.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'

export const [useActiveTimeouts, activeTimeouts$] = ReactRx.bind(
	RPC.observe('timeouts.watchActiveTimeouts', () => RPC.orpc.timeouts.watchActiveTimeouts.call()),
	[],
)

export function useTimeoutPlayerMutation() {
	return useMutation(RPC.orpc.timeouts.timeoutPlayer.mutationOptions())
}

export function useCancelTimeoutMutation() {
	return useMutation(RPC.orpc.timeouts.cancelTimeout.mutationOptions())
}

type TimeoutResult = { code: string }
type TimeoutInput = { serverId: string; playerId: SM.PlayerId; durationMs: number; reason?: string; presetReasonLabel?: string }

// the timeout endpoint is single-target, so bulk/squad timeouts fan out one call per player. Validates the shared
// duration once (mirroring the single-player dialog) and reports the outcome via toast. Individual failures are
// expected and non-fatal (e.g. a player already holds a timeout), so they're counted rather than thrown.
export async function timeoutPlayers(
	mutateAsync: (input: TimeoutInput) => Promise<TimeoutResult>,
	opts: {
		serverId: string
		playerIds: SM.PlayerId[]
		durationText: string
		maxTimeout: number | null | undefined
		reason?: string
		presetReasonLabel?: string
	},
): Promise<void> {
	const durationMs = ZodLib.tryParseHumanTimeToken(opts.durationText.trim())
	if (durationMs === undefined) {
		toast.error('Invalid duration', { description: 'Use a duration like 30m, 2h or 1d' })
		return
	}
	if (typeof opts.maxTimeout === 'number' && durationMs > opts.maxTimeout) {
		toast.error('Duration too long', { description: `Your maximum timeout is ${ZodLib.formatHumanTime(opts.maxTimeout)}` })
		return
	}
	const results = await Promise.allSettled(
		opts.playerIds.map(playerId =>
			mutateAsync({ serverId: opts.serverId, playerId, durationMs, reason: opts.reason, presetReasonLabel: opts.presetReasonLabel })
		),
	)
	let timedOut = 0
	let failed = 0
	for (const r of results) {
		if (r.status === 'fulfilled' && r.value.code === 'ok') timedOut++
		else failed++
	}
	const duration = ZodLib.formatHumanTime(durationMs)
	if (timedOut > 0) toast(`Timed out ${timedOut} player${timedOut === 1 ? '' : 's'} for ${duration}`)
	if (failed > 0) {
		toast.error(`${failed} timeout${failed === 1 ? '' : 's'} failed`, {
			description: 'They may already have an active timeout or have left the server.',
		})
	}
}

// the logged-in user's effective max timeout: undefined = cannot issue timeouts, null = unlimited,
// number = max ms. Timeout grants are comparator-matched, so RbacClient.usePermsCheck (equality) can't gate this.
export function useMaxTimeout(): number | null | undefined {
	const user = UsersClient.useLoggedInUser()
	if (!user) return undefined
	return RBAC.maxTimeoutDurationMs(RBAC.fromTracedPermissions(user.perms))
}
