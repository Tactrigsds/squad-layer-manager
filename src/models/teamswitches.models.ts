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
export type Teamswitch = z.infer<typeof TeamswitchSchema>
export const TeamswitchCollectionSchema = z.map(SM.PlayerIdSchema, TeamswitchSchema)
export type TeamswitchCollection = z.infer<typeof TeamswitchCollectionSchema>

export type EnrichedTeamswitch = Teamswitch & { player: SM.Player }

export function initTeamswitchCollection(): TeamswitchCollection {
	return new Map()
}

export type Message = {
	type: 'error'
	message: string
}

export type State = {
	switches: TeamswitchCollection
	players: Map<SM.PlayerId, MH.NormedTeamId>
	savedSwitches: TeamswitchCollection
	switching: boolean
}

export function initState(): State {
	return {
		switches: initTeamswitchCollection(),
		savedSwitches: initTeamswitchCollection(),
		players: new Map(),
		switching: false,
	}
}

export const TEAMSWITCH_CANCEL_REASON = z.enum(['player-left', 'player-changed-teams'])

export const OpSchema = z.discriminatedUnion('code', [
	z.object({
		opId: z.string(),
		code: z.literal('add-player-teamswitch'),
		saved: z.boolean(),
		source: USR.GuiOrChatUserIdSchema,
		playerId: SM.PlayerIdSchema,
		toTeam: MH.NormedTeamIdSchema,
	}),
	z.object({
		opId: z.string(),
		code: z.literal('remove-player-teamswitches'),
		source: USR.GuiOrChatUserIdSchema,
		playerId: SM.PlayerIdSchema,
		saved: z.boolean(),
	}),
	z.object({
		opId: z.string(),
		code: z.literal('reset-players'),
		players: z.map(SM.PlayerIdSchema, MH.NormedTeamIdSchema),
	}),
	z.object({
		opId: z.string(),
		code: z.literal('player-joined'),
		playerId: SM.PlayerIdSchema,
		team: MH.NormedTeamIdSchema,
	}),
	z.object({
		opId: z.string(),
		code: z.literal('player-left'),
		playerId: SM.PlayerIdSchema,
	}),
	z.object({
		opId: z.string(),
		code: z.literal('player-changed-team'),
		playerId: SM.PlayerIdSchema,
		toTeam: MH.NormedTeamIdSchema,
	}),
	z.object({ opId: z.string(), code: z.literal('revert-to-saved') }),
	z.object({ opId: z.string(), code: z.literal('clear-teamswitches'), save: z.boolean() }),

	z.object({ opId: z.string(), code: z.literal('save') }),

	z.object({ opId: z.string(), code: z.literal('execute-teamswitches'), source: USR.GuiOrChatUserIdSchema.optional() }),
	z.object({ opId: z.string(), code: z.literal('teamswitches-executed') }),
])

export type Op = z.infer<typeof OpSchema>
export type NewClientOp = DistributiveOmit<Op, 'opId'>

export function createOpId() {
	return createId(6)
}

type SwitchingMutationOp =
	| 'execute-teamswitches'
	| 'add-player-teamswitch'
	| 'remove-player-teamswitches'
	| 'revert-to-saved'
	| 'clear-teamswitches'
	| 'save'
	| 'player-changed-team'
	| 'player-left'

namespace OpErrors {
	export type CurrentlySwitching = { code: 'err:currently-switching' }
	export type Unexpected = { code: 'err:unexpected'; error: unknown }
}

export type OpError<OpCode extends Op['code'] = Op['code']> =
	| OpErrors.Unexpected
	| (OpCode extends SwitchingMutationOp ? OpErrors.CurrentlySwitching : never)

export type SideEffect =
	| {
		code: 'notify-upcoming-teamswitches'
		players: SM.PlayerId[]
	}
	| {
		code: 'notify-teamswitches-cancelled'
		players: SM.PlayerId[]
	}
	| {
		code: 'execute-teamswitches'
		opId: string
		switches: TeamswitchCollection
	}
	| {
		code: 'save'
		switches: TeamswitchCollection
		prevSaved: TeamswitchCollection
	}
	| {
		code: 'error'
		opId: string
		error: OpError
	}

export const reducer: RbSyncState.Reducer<Op, State, SideEffect> = (oldState, ops, prevOps, onSideEffect) => {
	let state = { ...oldState }
	for (const op of ops) {
		const emitError = (error: OpError) => onSideEffect?.({ code: 'error', opId: op.opId, error })
		try {
			// switch mutations
			switch (op.code) {
				case 'add-player-teamswitch': {
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}
					const switchEntry = { toTeam: op.toTeam, source: op.source }
					if (op.saved) {
						state.savedSwitches = new Map(state.savedSwitches)
						state.savedSwitches.set(op.playerId, switchEntry)
						state.switches = state.savedSwitches
					} else {
						state.switches = new Map(state.switches)
						state.switches.set(op.playerId, switchEntry)
					}
					break
				}

				case 'remove-player-teamswitches': {
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}
					if (op.saved) {
						state.savedSwitches = new Map(state.savedSwitches)
						if (state.savedSwitches.has(op.playerId)) {
							onSideEffect?.({ code: 'notify-teamswitches-cancelled', players: [op.playerId] })
						}
						state.savedSwitches.delete(op.playerId)
					} else {
						state.switches = new Map(state.switches)
						state.switches.delete(op.playerId)
					}
					break
				}

				case 'revert-to-saved': {
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}
					state.switches = state.savedSwitches
					break
				}

				case 'clear-teamswitches': {
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}
					if (op.save) {
						const playerIds = Array.from(state.savedSwitches.keys())
						if (playerIds.length > 0) onSideEffect?.({ code: 'notify-teamswitches-cancelled', players: playerIds })
						state.savedSwitches = state.switches = initTeamswitchCollection()
					} else {
						state.switches = initTeamswitchCollection()
					}
					break
				}

				case 'execute-teamswitches': {
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}
					state.switching = true
					onSideEffect?.({ code: 'execute-teamswitches', opId: op.opId, switches: state.savedSwitches })
					break
				}

				case 'teamswitches-executed': {
					if (!state.switching) break
					state.switching = false
					break
				}

				case 'player-joined': {
					state.players = new Map(state.players)
					state.players.set(op.playerId, op.team)
					break
				}

				case 'player-changed-team': {
					state.players = new Map(state.players)
					state.players.set(op.playerId, op.toTeam)
					const _switch = state.switches.get(op.playerId)
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}
					if (_switch && _switch.toTeam === op.toTeam) {
						state.switches = new Map(state.switches)
						state.switches.delete(op.playerId)
					}

					const savedSwitch = state.savedSwitches.get(op.playerId)
					if (savedSwitch && savedSwitch.toTeam === op.toTeam) {
						state.savedSwitches = new Map(state.savedSwitches)
						state.savedSwitches.delete(op.playerId)
					}

					break
				}

				case 'player-left': {
					state.players = new Map(state.players)
					state.players.delete(op.playerId)
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}

					const savedSwitch = state.savedSwitches.get(op.playerId)
					if (savedSwitch) {
						state.savedSwitches = new Map(state.savedSwitches)
						state.savedSwitches.delete(op.playerId)
					}
					break
				}

				case 'reset-players': {
					state.players = op.players
					break
				}

				case 'save': {
					if (state.switching) {
						emitError({ code: 'err:currently-switching' })
						break
					}
					const allPlayerIds = new Set([...state.savedSwitches.keys(), ...state.switches.keys()])
					const added: SM.PlayerId[] = []
					const removed: SM.PlayerId[] = []
					for (const playerId of allPlayerIds) {
						const savedSwitch = state.savedSwitches.get(playerId)
						const editedSwitch = state.switches.get(playerId)
						if (!savedSwitch && editedSwitch) {
							added.push(playerId)
						} else if (savedSwitch && !editedSwitch) {
							removed.push(playerId)
						}
					}
					if (added.length > 0) onSideEffect?.({ code: 'notify-upcoming-teamswitches', players: added })
					if (removed.length > 0) onSideEffect?.({ code: 'notify-teamswitches-cancelled', players: removed })
					state.savedSwitches = state.switches
					break
				}

				default: {
					assertNever(op)
				}
			}
		} catch (e) {
			emitError({ code: 'err:unexpected', error: e })
		}
	}
	if (state.savedSwitches !== oldState.savedSwitches) {
		const newSwitchingPlayers: SM.PlayerId[] = []
		for (const [playerId, _switch] of state.savedSwitches.entries()) {
			const toTeam = oldState.savedSwitches.get(playerId)?.toTeam
			if (!toTeam || toTeam !== _switch.toTeam) continue
			newSwitchingPlayers.push(playerId)
		}
		onSideEffect?.({ code: 'save', switches: state.savedSwitches, prevSaved: oldState.savedSwitches })
		if (newSwitchingPlayers.length > 0) onSideEffect?.({ code: 'notify-upcoming-teamswitches', players: newSwitchingPlayers })
	}

	return state
}

export type UpdateForClient = {
	code: 'init'
	state: State
	ops: Op[]
} | {
	code: 'op'
	ops: Op[]
}
