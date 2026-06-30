import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
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

function getTeamswitchChanges(next: TeamswitchCollection, prev: TeamswitchCollection) {
	const allPlayerIds = new Set([...next.keys(), ...prev.keys()])
	const added: SM.PlayerId[] = []
	const removed: SM.PlayerId[] = []
	for (const playerId of allPlayerIds) {
		const savedSwitch = prev.get(playerId)
		const editedSwitch = next.get(playerId)
		if (!savedSwitch && editedSwitch) {
			added.push(playerId)
		} else if (savedSwitch && !editedSwitch) {
			removed.push(playerId)
		}
	}

	return { added, removed }
}

export type PlayerCollection = Map<SM.PlayerId, MH.NormedTeamId>
function getPlayerChanges(next: PlayerCollection, prev: PlayerCollection) {
	const added: SM.PlayerId[] = []
	const removed: SM.PlayerId[] = []
	const changed: SM.PlayerId[] = []
	const allPlayerIds = new Set([...next.keys(), ...prev.keys()])
	for (const playerId of allPlayerIds) {
		const nextPlayer = next.get(playerId)
		const prevPlayer = prev.get(playerId)
		if (!prevPlayer && nextPlayer) {
			added.push(playerId)
		} else if (prevPlayer && !nextPlayer) {
			removed.push(playerId)
		} else if (prevPlayer && nextPlayer && prevPlayer !== nextPlayer) {
			changed.push(playerId)
		}
	}
	return { added, removed, changed }
}

export type EnrichedTeamswitch = Teamswitch & { player: SM.Player }

export function initTeamswitchCollection(): TeamswitchCollection {
	return new Map()
}

export function canSwitchNow(state: State, playerId: SM.PlayerId): boolean {
	return !state.switching && !state.pendingSwitches.has(playerId)
}

export function canQueue(state: State, playerId: SM.PlayerId): boolean {
	return !state.switching && !state.pendingSwitches.has(playerId) && !state.switches.has(playerId)
}

export function allCanSwitchNow(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.every(id => canSwitchNow(state, id))
}

export function allCanQueue(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.every(id => canQueue(state, id))
}

export function canExecuteSavedTeamswitches(state: State): boolean {
	return (
		state.switches === state.savedSwitches
		&& state.savedSwitches.size > 0
		&& !state.switching
		&& state.pendingSwitches.size === 0
	)
}

export function isSwitchPending(state: State, playerId: SM.PlayerId): boolean {
	return state.pendingSwitches.has(playerId)
}

export type Message = {
	type: 'error'
	message: string
}

export type State = {
	switches: TeamswitchCollection
	players: PlayerCollection
	savedSwitches: TeamswitchCollection
	pendingSwitches: TeamswitchCollection
	switching: boolean
}

export function initState(): State {
	return {
		switches: initTeamswitchCollection(),
		savedSwitches: initTeamswitchCollection(),
		pendingSwitches: initTeamswitchCollection(),
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
	z.object({ opId: z.string(), code: z.literal('revert-to-saved'), source: USR.GuiOrChatUserIdSchema.optional() }),
	z.object({ opId: z.string(), code: z.literal('clear-teamswitches'), save: z.boolean() }),

	z.object({ opId: z.string(), code: z.literal('save'), source: USR.GuiOrChatUserIdSchema }),
	z.object({ opId: z.string(), code: z.literal('execute-teamswitches'), source: USR.GuiOrChatUserIdSchema.optional() }),

	z.object({
		opId: z.string(),
		code: z.literal('switch-now'),
		switches: TeamswitchCollectionSchema,
		source: USR.GuiOrChatUserIdSchema,
	}),

	z.object({ opId: z.string(), code: z.literal('teamswitch-execution-completed') }),

	z.discriminatedUnion('reason', [
		z.object({ opId: z.string(), code: z.literal('teamswitch-execution-failed'), reason: z.literal('error'), message: z.string() }),
		z.object({
			opId: z.string(),
			code: z.literal('teamswitch-execution-failed'),
			reason: z.literal('not-all-players-switched'),
			playerIds: z.array(z.string()),
		}),
	]),
])

export type Op = z.infer<typeof OpSchema>
export type NewClientOp = DistributiveOmit<Op, 'opId'>

export function createOpId() {
	return createId(6)
}
type O = ReturnType<Map<string, any>['keys']>

type SwitchingMutationOp =
	| 'add-player-teamswitch'
	| 'remove-player-teamswitches'
	| 'revert-to-saved'
	| 'clear-teamswitches'
	| 'save'
	| 'player-changed-team'
	| 'player-left'

namespace OpErrors {
	export type CurrentlySwitching = { code: 'err:currently-switching' }
	export type CurrentlyNotSwitching = { code: 'err:currently-not-switching' }
	export type PendingSwitch = { code: 'err:pending-switch'; playerId: SM.PlayerId }
	export type SwitchesNotSaved = { code: 'err:switches-not-saved' }

	export type TeamswitchExecutionFailed = {
		code: 'err:teamswitch-execution-failed'
		reason: 'timeout' | 'error' | 'not-all-players-switched'
	}

	export type Unexpected = { code: 'err:unexpected'; error: unknown }
}

export type OpError<OpCode extends Op['code'] = Op['code']> =
	& { op: Extract<Op, { code: OpCode }> }
	& (
		| OpErrors.Unexpected
		| (OpCode extends SwitchingMutationOp ? (OpErrors.CurrentlySwitching | OpErrors.PendingSwitch)
			: OpCode extends 'teamswitch-execution-failed' ? (OpErrors.TeamswitchExecutionFailed)
			: OpCode extends 'teamswitch-execution-completed' ? (OpErrors.CurrentlyNotSwitching)
			: OpCode extends 'execute-teamswitches' ? (OpErrors.CurrentlySwitching | OpErrors.SwitchesNotSaved)
			: OpCode extends 'switch-now' ? OpErrors.CurrentlySwitching
			: never)
	)

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
		const emitOpError = <T extends Op>(error: OpError<T['code']>) => onSideEffect?.({ code: 'error', opId: error.op.opId, error })
		try {
			// switch mutations
			switch (op.code) {
				case 'add-player-teamswitch': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
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
						emitOpError({ code: 'err:currently-switching', op })
						break
					}

					if (state.pendingSwitches.has(op.playerId)) {
						emitOpError({ code: 'err:pending-switch', playerId: op.playerId, op })
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
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					state.switches = state.savedSwitches
					break
				}

				case 'clear-teamswitches': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
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
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					if (op.source && !Obj.deepEqual(state.switches, state.savedSwitches)) {
						emitOpError({ code: 'err:switches-not-saved', op })
						break
					}
					if (state.savedSwitches.size === 0) {
						break
					}
					state.switching = true
					state.pendingSwitches = state.savedSwitches
					const switches = state.savedSwitches
					state.savedSwitches = state.switches = initTeamswitchCollection()
					onSideEffect?.({ code: 'execute-teamswitches', opId: op.opId, switches })
					break
				}

				case 'teamswitch-execution-completed': {
					if (!state.switching) {
						emitOpError({ code: 'err:currently-not-switching', op })
						break
					}
					state.switching = false
					state.pendingSwitches = initTeamswitchCollection()
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
					let newSavedSwitches: State['savedSwitches'] | undefined
					let newSwitches: State['switches'] | undefined
					const allPlayerIds = new Set([...op.players.keys(), ...state.players.keys()])
					for (const playerId of allPlayerIds) {
						const nextPlayerTeam = op.players.get(playerId)
						const currentPlayerTeam = state.players.get(playerId)
						if (nextPlayerTeam && nextPlayerTeam === currentPlayerTeam) continue

						if (state.switching) continue
						const savedSwitch = state.savedSwitches.get(playerId)
						if (savedSwitch) {
							newSavedSwitches ??= new Map(state.savedSwitches)
							newSavedSwitches.delete(playerId)
						}
						let editedSwitch = state.switches.get(playerId)
						if (editedSwitch) {
							newSwitches ??= new Map(state.switches)
							newSwitches.delete(playerId)
						}
					}
					if (newSavedSwitches !== undefined) state.savedSwitches = newSavedSwitches
					if (newSwitches !== undefined) state.switches = newSwitches
					state.players = op.players
					break
				}

				case 'save': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					const { added, removed } = getTeamswitchChanges(state.switches, state.savedSwitches)
					state.savedSwitches = state.switches
					if (added.length > 0) onSideEffect?.({ code: 'notify-upcoming-teamswitches', players: added })
					if (removed.length > 0) onSideEffect?.({ code: 'notify-teamswitches-cancelled', players: removed })
					break
				}

				case 'teamswitch-execution-failed': {
					state.pendingSwitches = initTeamswitchCollection()
					state.switching = false
					emitOpError({
						code: 'err:teamswitch-execution-failed',
						reason: op.reason,
						op,
					})
					break
				}

				case 'switch-now': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}

					state.savedSwitches = new Map(state.savedSwitches)
					MapUtils.bulkDelete(state.savedSwitches, ...op.switches.keys())

					state.switches = new Map(state.switches)
					MapUtils.bulkDelete(state.switches, ...op.switches.keys())

					state.pendingSwitches = op.switches
					state.switching = true
					onSideEffect?.({ code: 'execute-teamswitches', opId: op.opId, switches: op.switches })

					break
				}
				default: {
					assertNever(op)
				}
			}
		} catch (e) {
			emitOpError({ code: 'err:unexpected', error: e, op })
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
