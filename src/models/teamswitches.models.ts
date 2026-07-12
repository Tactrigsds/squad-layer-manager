import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import { assertNever } from '@/lib/type-guards'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import type { DistributiveOmit } from '@tanstack/react-query'
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

export function getTeamswitchChanges(next: TeamswitchCollection, prev: TeamswitchCollection) {
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

// A write straight to the saved set (chat commands) commits immediately, but editedSwitches is shared state that
// GUI clients may have unsaved work in. Rather than discarding that work, apply the same mutation to the edit set
// so the committed change lands there too and the rest of the pending edits survive. An edit set that was already
// in sync stays in sync (and so stays reference-equal, which is how the rest of the model detects "not dirty").
function writeToSaved(state: State, mutate: (switches: TeamswitchCollection) => void) {
	const synced = state.editedSwitches === state.savedSwitches
	state.savedSwitches = new Map(state.savedSwitches)
	mutate(state.savedSwitches)
	if (synced) {
		state.editedSwitches = state.savedSwitches
		return
	}
	state.editedSwitches = new Map(state.editedSwitches)
	mutate(state.editedSwitches)
}

export type PlayerCollection = Map<SM.PlayerId, MH.NormedTeamId>

export type EnrichedTeamswitch = Teamswitch & { player: SM.Player }

export function initTeamswitchCollection(): TeamswitchCollection {
	return new Map()
}

export function canSwitchNow(state: State, playerId: SM.PlayerId): boolean {
	return !state.switching && !state.pendingSwitches.has(playerId)
}

export function canQueue(state: State, playerId: SM.PlayerId): boolean {
	return !state.switching && !state.pendingSwitches.has(playerId) && !state.editedSwitches.has(playerId)
}

export function allCanSwitchNow(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.every(id => canSwitchNow(state, id))
}

export function allCanQueue(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.every(id => canQueue(state, id))
}

export function someCanQueue(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.some(id => canQueue(state, id))
}

export function canExecuteSavedTeamswitches(state: State): boolean {
	return (
		state.editedSwitches === state.savedSwitches
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
	editedSwitches: TeamswitchCollection
	players: PlayerCollection
	savedSwitches: TeamswitchCollection
	pendingSwitches: TeamswitchCollection
	switching: boolean
	// who triggered the in-flight execution, null when it was the map roll (or nothing is executing). the sources on
	// the switches themselves say who *queued* each player, which is a different question and a different admin
	switchingSource: USR.GuiOrChatUserId | null
	// the op that started the in-flight execution. lets a background watcher tell "the execution I started is still
	// pending" from "it already resolved, or a different one is running now"
	switchingOpId: string | null
}

export function initState(savedSwitches?: TeamswitchCollection): State {
	return {
		editedSwitches: initTeamswitchCollection(),
		savedSwitches: savedSwitches ?? initTeamswitchCollection(),
		pendingSwitches: initTeamswitchCollection(),
		players: new Map(),
		switching: false,
		switchingSource: null,
		switchingOpId: null,
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
		code: z.literal('init-saved-teamswitches'),
		switches: TeamswitchCollectionSchema,
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
	z.object({ opId: z.string(), code: z.literal('clear-teamswitches'), save: z.boolean(), source: USR.GuiOrChatUserIdSchema.optional() }),

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
		// the execution never resolved: the switches were fired but the teams never came back showing them applied
		z.object({ opId: z.string(), code: z.literal('teamswitch-execution-failed'), reason: z.literal('timeout') }),
	]),
])

export type Op = z.infer<typeof OpSchema>
export type NewClientOp = DistributiveOmit<Op, 'opId'>

export function createOpId() {
	return createId(6)
}
type SwitchingMutationOp =
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
	export type AlreadyMarked = { code: 'err:already-marked'; playerId: SM.PlayerId }
	export type SwitchesNotSaved = { code: 'err:switches-not-saved' }
	export type NothingQueued = { code: 'err:nothing-queued' }

	export type Unexpected = { code: 'err:unexpected'; error: unknown }
}

export type OpError<OpCode extends Op['code'] = Op['code']> =
	& { op: Extract<Op, { code: OpCode }> }
	& (
		| OpErrors.Unexpected
		| (OpCode extends 'add-player-teamswitch' ? (OpErrors.CurrentlySwitching | OpErrors.AlreadyMarked)
			: OpCode extends 'clear-teamswitches' ? (OpErrors.CurrentlySwitching | OpErrors.PendingSwitch | OpErrors.NothingQueued)
			: OpCode extends SwitchingMutationOp ? (OpErrors.CurrentlySwitching | OpErrors.PendingSwitch)
			// teamswitch-execution-failed never errors: it reports through a side effect, since rejecting the batch
			// would discard the very state change (cancelling the pending switches) that it exists to make
			: OpCode extends 'teamswitch-execution-completed' ? (OpErrors.CurrentlyNotSwitching)
			: OpCode extends 'execute-teamswitches' ? (OpErrors.CurrentlySwitching | OpErrors.SwitchesNotSaved)
			: OpCode extends 'switch-now' ? OpErrors.CurrentlySwitching
			: OpCode extends 'init-saved-teamswitches' ? OpErrors.CurrentlySwitching
			: never)
	)

// the typed payload carried by a RejectedError thrown from the reducer: either a specific op failure
// the dispatcher should surface, or a benign no-op that changed nothing (nothing to report)
export type Rejection = OpError | { code: 'noop' }

// what drove a change to the saved (queued) teamswitches:
//  - 'user-edit': an admin saved, queued, or cleared switches (gui or chat command)
//  - 'executed': the saved queue was executed and drained (map roll, or a manual execute)
//  - 'switched-now': a player was switched immediately, which drops them from the queue if they were in it. the
//    switch itself is the action here, not the queue change, and it's already recorded as a TEAM_CHANGE_FORCED
//  - 'roster-change': a queued player left or changed teams on their own, so their switch no longer applies
export const SaveTriggerSchema = z.enum(['user-edit', 'executed', 'switched-now', 'roster-change'])
export type SaveTrigger = z.infer<typeof SaveTriggerSchema>

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
		source?: USR.GuiOrChatUserId
		trigger: SaveTrigger
	}
	| {
		code: 'teamswitches-executed'
		switchCount: number
		source?: USR.GuiOrChatUserId
	}
	| {
		code: 'teamswitch-execution-failed'
		reason: 'error' | 'not-all-players-switched' | 'timeout'
		// for 'error'
		message?: string
		// for 'not-all-players-switched': the players still on the wrong team
		playerIds?: SM.PlayerId[]
		source?: USR.GuiOrChatUserId
	}
	| {
		code: 'end-all-teamswitch-editing'
	}
	| {
		code: 'op-outcome'
		op: Op
		success: boolean
	}

export const reducer: ODSM.Reducer<Op, State, SideEffect> = (oldState, ops, _prevOps) => {
	let state = { ...oldState }
	const sideEffects: SideEffect[] = []
	const emit = (se: SideEffect) => sideEffects.push(se)
	// the first per-op failure rejects the whole (dependent) batch; recorded here and thrown below
	let firstError: OpError | undefined
	let skipEmitSave = false
	// restoring saved switches from the db isn't a new marking -- those players were already warned before the
	// restart. no op that can be batched alongside init-saved-teamswitches adds saved switches, so suppressing
	// for the whole batch loses nothing.
	let skipNotifyUpcoming = false
	let saveSource: USR.GuiOrChatUserId | undefined
	// what drove the change to savedSwitches, for the TEAMSWITCHES_UPDATED app event. set by every op that mutates
	// it; a batch only ever mixes ops of one kind (a roster event, or one user action)
	let saveTrigger: SaveTrigger | undefined
	for (const op of ops) {
		let opFailed = false
		const emitOpError = <T extends Op>(error: OpError<T['code']>) => {
			opFailed = true
			firstError ??= error
		}
		try {
			// switch mutations
			switch (op.code) {
				case 'add-player-teamswitch': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					// a saved write is only in conflict with what's actually queued: another client's unsaved mark for
					// this player isn't a switch yet, so it mustn't fail an admin's chat command
					const marked = op.saved ? state.savedSwitches : state.editedSwitches
					if (marked.has(op.playerId)) {
						emitOpError({ code: 'err:already-marked', playerId: op.playerId, op })
						break
					}
					const switchEntry = { toTeam: op.toTeam, source: op.source }
					if (op.saved) {
						writeToSaved(state, switches => switches.set(op.playerId, switchEntry))
						saveSource = op.source
						saveTrigger = 'user-edit'
					} else {
						state.editedSwitches = new Map(state.editedSwitches)
						state.editedSwitches.set(op.playerId, switchEntry)
					}
					break
				}

				case 'init-saved-teamswitches': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					state.savedSwitches = new Map(state.savedSwitches)
					skipEmitSave = true
					skipNotifyUpcoming = true
					// a switch that's no longer applicable (the player left, or is already on the target team) is
					// dropped, and dropping any means the pruned collection has to be re-saved
					saveTrigger = 'roster-change'
					for (const [playerId, switchEntry] of op.switches.entries()) {
						const team = state.players.get(playerId)
						if (team && team !== switchEntry.toTeam) state.savedSwitches.set(playerId, switchEntry)
						else {
							skipEmitSave = false
						}
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
						if (state.savedSwitches.has(op.playerId)) {
							emit({ code: 'notify-teamswitches-cancelled', players: [op.playerId] })
						}
						// the delete has to reach editedSwitches too, or the player stays marked there and can never be
						// re-added (add-player-teamswitch would reject them as already-marked)
						writeToSaved(state, switches => switches.delete(op.playerId))
						saveSource = op.source
						saveTrigger = 'user-edit'
					} else {
						state.editedSwitches = new Map(state.editedSwitches)
						state.editedSwitches.delete(op.playerId)
					}
					break
				}

				case 'revert-to-saved': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					state.editedSwitches = state.savedSwitches
					break
				}

				case 'clear-teamswitches': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					if (op.save) {
						// clearing the queue only clears what's queued: unsaved marks another client is still working on
						// were never switches, so they're left in the edit set rather than discarded
						const playerIds = Array.from(state.savedSwitches.keys())
						if (playerIds.length === 0) {
							emitOpError({ code: 'err:nothing-queued', op })
							break
						}
						emit({ code: 'notify-teamswitches-cancelled', players: playerIds })
						writeToSaved(state, switches => MapUtils.bulkDelete(switches, ...playerIds))
						if (op.source) saveSource = op.source
						saveTrigger = 'user-edit'
					} else {
						state.editedSwitches = initTeamswitchCollection()
					}
					break
				}

				case 'execute-teamswitches': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					if (op.source && !Obj.deepEqual(state.editedSwitches, state.savedSwitches)) {
						emitOpError({ code: 'err:switches-not-saved', op })
						break
					}
					if (state.savedSwitches.size === 0) {
						break
					}
					state.switching = true
					state.switchingSource = op.source ?? null
					state.switchingOpId = op.opId
					state.pendingSwitches = state.savedSwitches
					const switches = state.savedSwitches
					state.savedSwitches = state.editedSwitches = initTeamswitchCollection()
					saveTrigger = 'executed'
					saveSource = op.source
					emit({ code: 'execute-teamswitches', opId: op.opId, switches })
					break
				}

				case 'teamswitch-execution-completed': {
					if (!state.switching) {
						emitOpError({ code: 'err:currently-not-switching', op })
						break
					}
					const switchCount = state.pendingSwitches.size
					const executionSource = state.switchingSource ?? undefined
					state.switchingSource = null
					state.switchingOpId = null
					state.switching = false
					state.pendingSwitches = initTeamswitchCollection()
					emit({ code: 'teamswitches-executed', switchCount, source: executionSource })
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
					const _switch = state.editedSwitches.get(op.playerId)

					if (state.switching) {
						break
					}
					if (_switch && _switch.toTeam === op.toTeam) {
						state.editedSwitches = new Map(state.editedSwitches)
						state.editedSwitches.delete(op.playerId)
					}

					const savedSwitch = state.savedSwitches.get(op.playerId)
					if (savedSwitch && savedSwitch.toTeam === op.toTeam) {
						state.savedSwitches = new Map(state.savedSwitches)
						state.savedSwitches.delete(op.playerId)
						saveTrigger = 'roster-change'
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
						saveTrigger = 'roster-change'
					}
					break
				}

				case 'reset-players': {
					let newSavedSwitches: State['savedSwitches'] | undefined
					let newSwitches: State['editedSwitches'] | undefined
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
						let editedSwitch = state.editedSwitches.get(playerId)
						if (editedSwitch) {
							newSwitches ??= new Map(state.editedSwitches)
							newSwitches.delete(playerId)
						}
					}
					if (newSavedSwitches !== undefined) {
						state.savedSwitches = newSavedSwitches
						saveTrigger = 'roster-change'
					}
					if (newSwitches !== undefined) state.editedSwitches = newSwitches
					state.players = op.players
					break
				}

				case 'save': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}
					// newly marked players are notified by the generic savedSwitches diff below; cancellations are
					// per-op, since a switch dropped because the player left or already changed teams shouldn't warn
					const { removed } = getTeamswitchChanges(state.editedSwitches, state.savedSwitches)
					state.savedSwitches = state.editedSwitches
					saveSource = op.source
					saveTrigger = 'user-edit'
					if (removed.length > 0) emit({ code: 'notify-teamswitches-cancelled', players: removed })
					break
				}

				case 'teamswitch-execution-failed': {
					// a failure is reported as a side effect rather than an op error on purpose: an op error rejects the
					// batch, and a rejected batch changes no state (see ODSM.Applied), so the pending switches this op
					// exists to cancel would survive it and stay pending forever
					if (!state.switching) break
					const source = state.switchingSource ?? undefined
					state.pendingSwitches = initTeamswitchCollection()
					state.switching = false
					state.switchingSource = null
					state.switchingOpId = null
					emit({
						code: 'teamswitch-execution-failed',
						reason: op.reason,
						message: op.reason === 'error' ? op.message : undefined,
						playerIds: op.reason === 'not-all-players-switched' ? op.playerIds : undefined,
						source,
					})
					break
				}

				case 'switch-now': {
					if (state.switching) {
						emitOpError({ code: 'err:currently-switching', op })
						break
					}

					// switching a player now takes them out of the queue on both sets, but leaves the rest of an
					// in-flight edit (and its in-sync-ness) intact
					writeToSaved(state, switches => MapUtils.bulkDelete(switches, ...op.switches.keys()))
					saveTrigger = 'switched-now'
					saveSource = op.source

					state.pendingSwitches = op.switches
					state.switching = true
					state.switchingSource = op.source
					state.switchingOpId = op.opId
					emit({ code: 'execute-teamswitches', opId: op.opId, switches: op.switches })

					break
				}
				default: {
					assertNever(op)
				}
			}
		} catch (e) {
			emitOpError({ code: 'err:unexpected', error: e, op })
		}
		emit({ code: 'op-outcome', op, success: !opFailed })
	}
	// a failing op rejects the whole dependent batch, carrying the (typed) error as the rejection data
	// for the dispatcher to surface; the partially-mutated state is discarded
	if (firstError) throw new ODSM.RejectedError<Rejection>(firstError)

	if (state.savedSwitches !== oldState.savedSwitches && !skipEmitSave) {
		// only players who weren't already marked for this team are newly switching. every mutation of
		// savedSwitches lands here, including prunes (player-left, player-changed-team, reset-players) and
		// switch-now, so warning anything but the actual diff re-warns players who are already marked.
		const newSwitchingPlayers: SM.PlayerId[] = []
		for (const [playerId, _switch] of state.savedSwitches.entries()) {
			const prevToTeam = oldState.savedSwitches.get(playerId)?.toTeam
			if (prevToTeam === _switch.toTeam) continue
			newSwitchingPlayers.push(playerId)
		}
		emit({
			code: 'save',
			switches: state.savedSwitches,
			prevSaved: oldState.savedSwitches,
			source: saveSource,
			trigger: saveTrigger ?? 'user-edit',
		})
		if (!skipNotifyUpcoming && newSwitchingPlayers.length > 0) {
			emit({ code: 'notify-upcoming-teamswitches', players: newSwitchingPlayers })
		}
	}

	// editedSwitches is shared server state, so resolving it (save, revert, clear, execute) resolves it for
	// everyone at once: nobody is left with pending edits, and so nobody is left editing. reference equality is
	// the established synced signal (see canExecuteSavedTeamswitches)
	if (state.editedSwitches === state.savedSwitches && oldState.editedSwitches !== oldState.savedSwitches) {
		emit({ code: 'end-all-teamswitch-editing' })
	}

	// the reducer mutates a shallow copy, reassigning a field only when it actually changes it, so
	// reference-equal fields mean the batch produced no net change -- a benign no-op we reject so it's
	// dropped rather than broadcast.
	const unchanged = state.editedSwitches === oldState.editedSwitches
		&& state.savedSwitches === oldState.savedSwitches
		&& state.pendingSwitches === oldState.pendingSwitches
		&& state.players === oldState.players
		&& state.switching === oldState.switching
	if (unchanged) throw new ODSM.RejectedError<Rejection>({ code: 'noop' })

	return [state, sideEffects]
}

export type UpdateForClient = {
	code: 'init'
	state: State
	ops: Op[]
} | {
	code: 'op'
	ops: Op[]
} | {
	// ops are deterministic, so the originator only receives the ids of its own acked ops and
	// replays its pending copies
	code: 'ack'
	opIds: string[]
}
