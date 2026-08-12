// Player-initiated team switching. /switch swaps the sender immediately when their own team is large enough to
// spare them (see instantSwapLead), and otherwise queues them FIFO. The queue drains by mutual swaps (a waiter on
// each side), by the same population rule as the instant path, or by moving a just-connected player aside to make
// room. It resets every game. The planner here is pure; execution lives in systems/switch-requests.server.ts.
import type { MutexInterface } from 'async-mutex'
import { z } from 'zod'

import * as CD from '@/lib/ctx-def'
import type { IsolatedSubject } from '@/lib/isolated-subject'
import * as CS from '@/models/context-shared'
import * as SM from '@/models/squad.models'

export const SwitchRequestSchema = z.object({
	playerId: SM.PlayerIdSchema,
	// the team the player was on when they asked; the destination is always the other one. A player observed off
	// their origin team got what they asked for (or was moved by someone else), either way the request is spent.
	fromTeam: SM.TeamIdSchema,
	requestedAt: z.number(),
})
export type SwitchRequest = z.infer<typeof SwitchRequestSchema>

export type State = {
	// FIFO across both directions; a direction's queue is the subsequence sharing fromTeam
	requests: SwitchRequest[]
	// who disconnected during the current match: a rejoin is not a neutral connector (see the connector rule)
	disconnectedThisMatch: Set<SM.PlayerId>
}

export function initState(): State {
	return { requests: [], disconnectedThisMatch: new Set() }
}

export function requestFor(requests: SwitchRequest[], playerId: SM.PlayerId): SwitchRequest | undefined {
	return requests.find((r) => r.playerId === playerId)
}

export function queueFor(requests: SwitchRequest[], fromTeam: SM.TeamId): SwitchRequest[] {
	return requests.filter((r) => r.fromTeam === fromTeam)
}

// 1-based position within the player's own direction, which is the number they are told in-game
export function position(requests: SwitchRequest[], playerId: SM.PlayerId): number | null {
	const request = requestFor(requests, playerId)
	if (!request) return null
	return queueFor(requests, request.fromTeam).findIndex((r) => r.playerId === playerId) + 1
}

export function positions(requests: SwitchRequest[]): Map<SM.PlayerId, number> {
	const out = new Map<SM.PlayerId, number>()
	const counts: Record<SM.TeamId, number> = { 1: 0, 2: 0 }
	for (const request of requests) {
		counts[request.fromTeam]++
		out.set(request.playerId, counts[request.fromTeam])
	}
	return out
}

// null = listed but not yet sorted onto a team (mid-roll); absent = not on the server
export type Roster = Map<SM.PlayerId, SM.TeamId | null>

export function rosterOf(players: Pick<SM.Player, 'ids' | 'teamId'>[]): Roster {
	const roster: Roster = new Map()
	for (const player of players) roster.set(SM.PlayerIds.getPlayerId(player.ids), player.teamId)
	return roster
}

function teamCounts(roster: Roster): Record<SM.TeamId, number> {
	const counts: Record<SM.TeamId, number> = { 1: 0, 2: 0 }
	for (const teamId of roster.values()) {
		if (teamId !== null) counts[teamId]++
	}
	return counts
}

// whether a player on fromTeam may switch right now under the population rule
export function meetsInstantSwapLead(roster: Roster, fromTeam: SM.TeamId, instantSwapLead: number): boolean {
	const counts = teamCounts(roster)
	return counts[fromTeam] - counts[SM.oppositeTeamId(fromTeam)] >= instantSwapLead
}

export type PlannedSwap = {
	playerId: SM.PlayerId
	fromTeam: SM.TeamId
	toTeam: SM.TeamId
	via: 'mutual' | 'capacity' | 'connector'
}

export type Removal = { playerId: SM.PlayerId; reason: 'disconnected' | 'fulfilled-externally' }

export type PlanInput = {
	requests: SwitchRequest[]
	roster: Roster
	instantSwapLead: number
	// players with a forced switch already in flight; their requests are held, not re-planned
	swapping: ReadonlySet<SM.PlayerId>
	// a player just placed on their first team this match. Their arrival on the target side of a waiting queue
	// blocks it (n vs n+1 never meets the lead), so they are moved to the other side and the head takes their slot;
	// population-neutral, and fair because they had no allegiance yet.
	connector?: { playerId: SM.PlayerId; teamId: SM.TeamId }
}

export type Plan = {
	// the queue after removals and fulfillments, in original order
	requests: SwitchRequest[]
	// forced switches to fire: fulfilled queue members, plus the connector's own move when one was used
	swaps: PlannedSwap[]
	// queue members leaving via a swap in this plan
	fulfilled: SM.PlayerId[]
	removed: Removal[]
}

export function plan(input: PlanInput): Plan {
	const { roster, instantSwapLead, swapping, connector } = input

	const remaining: SwitchRequest[] = []
	const removed: Removal[] = []
	for (const request of input.requests) {
		const teamId = roster.get(request.playerId)
		if (teamId === undefined) removed.push({ playerId: request.playerId, reason: 'disconnected' })
		else if (teamId !== null && teamId !== request.fromTeam) removed.push({ playerId: request.playerId, reason: 'fulfilled-externally' })
		else remaining.push(request)
	}

	const counts = teamCounts(roster)
	const swaps: PlannedSwap[] = []
	const fulfilled: SM.PlayerId[] = []

	// the oldest request in a direction that can actually be fired: not already in flight, and on a team (a
	// null-team player can't be force-switched; they keep their place until the roster settles)
	const head = (fromTeam: SM.TeamId) =>
		remaining.find((r) => r.fromTeam === fromTeam && !swapping.has(r.playerId) && roster.get(r.playerId) === fromTeam)

	const fulfill = (request: SwitchRequest, via: PlannedSwap['via']) => {
		const toTeam = SM.oppositeTeamId(request.fromTeam)
		swaps.push({ playerId: request.playerId, fromTeam: request.fromTeam, toTeam, via })
		fulfilled.push(request.playerId)
		remaining.splice(remaining.indexOf(request), 1)
		counts[request.fromTeam]--
		counts[toTeam]++
	}

	if (connector && !swapping.has(connector.playerId) && !requestFor(remaining, connector.playerId)) {
		const waiting = head(SM.oppositeTeamId(connector.teamId))
		if (waiting) {
			const connectorTo = SM.oppositeTeamId(connector.teamId)
			swaps.push({ playerId: connector.playerId, fromTeam: connector.teamId, toTeam: connectorTo, via: 'connector' })
			counts[connector.teamId]--
			counts[connectorTo]++
			fulfill(waiting, 'connector')
		}
	}

	while (true) {
		const h1 = head(1)
		const h2 = head(2)
		if (!h1 || !h2) break
		fulfill(h1, 'mutual')
		fulfill(h2, 'mutual')
	}

	for (const fromTeam of [1, 2] as const) {
		while (counts[fromTeam] - counts[SM.oppositeTeamId(fromTeam)] >= instantSwapLead) {
			const request = head(fromTeam)
			if (!request) break
			fulfill(request, 'capacity')
		}
	}

	return { requests: remaining, swaps, fulfilled, removed }
}

// what the client sees: the queue, plus who has a forced switch in flight. Direction and position are derivable,
// and the roster arrives separately.
export type UpdateForClient = { requests: SwitchRequest[]; swapping: SM.PlayerId[] }

export type InFlight = {
	toTeam: SM.TeamId
	via: PlannedSwap['via']
	firedAt: number
	attempts: number
	// the app event that recorded this switch, re-armed for attribution when the switch is re-fired
	causeId: string
}

export type Ctx = CS.Ctx & { switchRequests: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['switchRequests'], { name: 'switchRequests', extends: [CS.ServerIdDef] })

export namespace Ctx {
	export type Payload = {
		state: State
		update$: IsolatedSubject<UpdateForClient>
		mutex: MutexInterface
		// connected this match, not yet sorted onto a team; their first placement is the connector moment
		pendingPlacement: Set<SM.PlayerId>
		swapping: Map<SM.PlayerId, InFlight>
		haveReadFromDb: boolean
	}
}
