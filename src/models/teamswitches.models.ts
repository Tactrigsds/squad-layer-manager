import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import type * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import { DistributiveOmit } from '@tanstack/react-query'
import { z } from 'zod'

export const TeamswitchStatusSchema = z.enum(['ready', 'player-disconnected', 'player-changed-teams'])
export type TeamswitchStatus = z.infer<typeof TeamswitchStatusSchema>

// players are listed under the team they will be swapped to
export const TeamswitchSchema = z.object({
	toTeam: MH.NormedTeamIdSchema,
	source: USR.GuiOrChatUserIdSchema,
})
export const TeamswitchCollectionSchema = z.map(SM.PlayerIdSchema, TeamswitchSchema)
type TeamswitchCollection = z.infer<typeof TeamswitchCollectionSchema>
export const TeamswitchStatusCollectionSchema = z.map(SM.PlayerIdSchema, TeamswitchStatusSchema)
type TeamswitchStatusCollection = z.infer<typeof TeamswitchStatusCollectionSchema>

function initTeamswitchCollection(): TeamswitchCollection {
	return new Map()
}

function initTeamswitchStatusCollection(): TeamswitchStatusCollection {
	return new Map()
}

export type State = {
	switches: TeamswitchCollection
	statuses: TeamswitchStatusCollection
	savedSwitches: TeamswitchCollection
	switching: boolean
	editors: Set<USR.UserId>
}
export function initState(): State {
	return {
		switches: initTeamswitchCollection(),
		statuses: initTeamswitchStatusCollection(),
		savedSwitches: initTeamswitchCollection(),
		switching: false,
		editors: new Set(),
	}
}

export const OpSchema = z.discriminatedUnion('code', [
	z.object({
		opId: z.string(),
		code: z.literal('add-player-teamswitches'),
		source: USR.GuiOrChatUserIdSchema,
		playerIds: z.set(SM.PlayerIdSchema),
		toTeam: MH.NormedTeamIdSchema,
	}),
	z.object({
		opId: z.string(),
		code: z.literal('remove-player-teamswitch'),
		source: USR.GuiOrChatUserIdSchema,
		playerId: SM.PlayerIdSchema,
	}),
	z.object({ opId: z.string(), code: z.literal('remove-team-teamswitch'), user: USR.GuiOrChatUserIdSchema, teamId: MH.NormedTeamIdSchema }),
	z.object({ opId: z.string(), code: z.literal('remove-all-teamswitches') }),
	z.object({
		opId: z.string(),
		code: z.literal('set-switch-statuses'),
		delta: TeamswitchStatusCollectionSchema,
	}),
	z.object({ opId: z.string(), code: z.literal('execute-teamswitches') }),
	z.object({ opId: z.string(), code: z.literal('complete-teamswitch-execution') }),
	z.object({ opId: z.string(), code: z.literal('start-editing'), userId: USR.UserIdSchema }),
	z.object({ opId: z.string(), code: z.literal('finish-editing'), userId: USR.UserIdSchema, forceSave: z.boolean().optional() }),
])

export type Op = z.infer<typeof OpSchema>
export type NewClientOp = DistributiveOmit<Op, 'opId'>

export function createOpId() {
	return createId(6)
}

export type SideEffect = {
	code: 'switches-mutated'
} | {
	code: 'executing-teamswitch'
	switches: TeamswitchCollection
} | {
	code: 'saving'
	switches: TeamswitchCollection
	prevSaved: TeamswitchCollection
	statuses: TeamswitchStatusCollection
} | {
	code: 'error'
	error: unknown
}

export const reducer: RbSyncState.Reducer<Op, State, SideEffect> = (oldState, ops, prevOps, onSideEffect) => {
	const state = Obj.deepClone(oldState)
	for (const op of ops) {
		try {
			// switch mutations
			switch (op.code) {
				case 'add-player-teamswitches': {
					if (state.switching) break
					for (const playerId of op.playerIds) {
						state.switches.set(playerId, { toTeam: op.toTeam, source: op.source })
						state.statuses.set(playerId, 'ready')
					}
					break
				}

				case 'remove-player-teamswitch': {
					if (state.switching) break
					state.switches.delete(op.playerId)
					state.statuses.delete(op.playerId)
					onSideEffect?.({ code: 'switches-mutated' })
					break
				}

				case 'remove-team-teamswitch': {
					if (state.switching) break
					const playerIds = Array.from(state.switches.keys())
					for (const playerId of playerIds) {
						if (state.switches.get(playerId)!.toTeam === op.teamId) {
							state.switches.delete(playerId)
							state.statuses.delete(playerId)
						}
					}
					onSideEffect?.({ code: 'switches-mutated' })
					break
				}

				case 'remove-all-teamswitches': {
					if (state.switching) break
					state.switches.clear()
					state.statuses.clear()
					onSideEffect?.({ code: 'switches-mutated' })
					break
				}

				case 'set-switch-statuses': {
					if (state.switching) break
					for (const [playerId, status] of op.delta.entries()) {
						if (!state.switches.has(playerId)) continue
						state.statuses.set(playerId, status)
					}
					break
				}

				case 'execute-teamswitches': {
					if (state.switching) break
					state.switching = true
					onSideEffect?.({ code: 'executing-teamswitch', switches: Obj.deepClone(state.savedSwitches) })
					break
				}

				case 'complete-teamswitch-execution': {
					if (!state.switching) {
						onSideEffect?.({ code: 'error', error: new Error('complete-teamswitch-execution called while not switching') })
						break
					}
					state.switching = false
					state.switches = initTeamswitchCollection()
					state.statuses = initTeamswitchStatusCollection()
					state.savedSwitches = initTeamswitchCollection()
					onSideEffect?.({ code: 'switches-mutated' })
					break
				}

				case 'start-editing': {
					state.editors.add(op.userId)
					break
				}

				case 'finish-editing': {
					state.editors.delete(op.userId)
					if (op.forceSave || state.editors.size === 0) {
						onSideEffect?.({
							code: 'saving',
							switches: state.switches,
							prevSaved: state.savedSwitches,
							statuses: Obj.deepClone(state.statuses),
						})
						state.savedSwitches = Obj.deepClone(state.switches)
					}
					break
				}

				default: {
					assertNever(op)
				}
			}
		} catch (e) {
			onSideEffect?.({ code: 'error', error: e })
		}
	}

	return state
}

export function getTeamswitchStatusDelta(state: State, players: SM.Player[], historyEntryOrdinal: number) {
	if (state.switches.size === 0) return
	const missingPlayerIds = new Set(state.switches.keys())
	const delta: TeamswitchStatusCollection = new Map()
	for (const player of players) {
		const playerId = SM.PlayerIds.getPlayerId(player.ids)
		const teamswitch = state.switches.get(playerId)
		const status = state.statuses.get(playerId)
		if (!teamswitch) continue
		if (!player.teamId) continue
		missingPlayerIds.delete(playerId)
		const team = MH.getNormedTeamId(player.teamId, historyEntryOrdinal)
		let chosenStatus: TeamswitchStatus

		if (teamswitch.toTeam === team) {
			chosenStatus = 'player-changed-teams'
		} else {
			chosenStatus = 'ready'
		}

		if (chosenStatus !== status) {
			delta.set(playerId, chosenStatus)
		}
		return delta
	}

	for (const playerId of missingPlayerIds.values()) {
		state.statuses.set(playerId, 'player-disconnected')
	}
}

export type UpdateForClient = {
	code: 'init'
	state: State
	ops: Op[]
} | {
	code: 'op'
	op: Op
}
