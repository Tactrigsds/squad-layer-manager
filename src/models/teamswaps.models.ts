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

export const TeamswapStatusSchema = z.enum(['ready', 'player-disconnected', 'player-changed-teams'])
export type TeamswapStatus = z.infer<typeof TeamswapStatusSchema>

// players are listed under the team they will be swapped to
export const TeamswapSchema = z.object({
	toTeam: MH.NormedTeamIdSchema,
	source: USR.GuiOrChatUserIdSchema,
})
export type Teamswap = z.infer<typeof TeamswapSchema>
export const TeamswapCollectionSchema = z.map(SM.PlayerIdSchema, TeamswapSchema)
export type TeamswapCollection = z.infer<typeof TeamswapCollectionSchema>

export function getTeamswapChanges(next: TeamswapCollection, prev: TeamswapCollection) {
	const allPlayerIds = new Set([...next.keys(), ...prev.keys()])
	const added: SM.PlayerId[] = []
	const removed: SM.PlayerId[] = []
	for (const playerId of allPlayerIds) {
		const savedSwap = prev.get(playerId)
		const editedSwap = next.get(playerId)
		if (!savedSwap && editedSwap) {
			added.push(playerId)
		} else if (savedSwap && !editedSwap) {
			removed.push(playerId)
		}
	}

	return { added, removed }
}

// A write straight to the saved set (chat commands) commits immediately, but editedSwaps is shared state that
// GUI clients may have unsaved work in. Rather than discarding that work, apply the same mutation to the edit set
// so the committed change lands there too and the rest of the pending edits survive. An edit set that was already
// in sync stays in sync (and so stays reference-equal, which is how the rest of the model detects "not dirty").
function writeToSaved(state: State, mutate: (swaps: TeamswapCollection) => void) {
	const synced = state.editedSwaps === state.savedSwaps
	state.savedSwaps = new Map(state.savedSwaps)
	mutate(state.savedSwaps)
	if (synced) {
		state.editedSwaps = state.savedSwaps
		return
	}
	state.editedSwaps = new Map(state.editedSwaps)
	mutate(state.editedSwaps)
}

export type PlayerCollection = Map<SM.PlayerId, MH.NormedTeamId>

export type EnrichedTeamswap = Teamswap & { player: SM.Player }

export function initTeamswapCollection(): TeamswapCollection {
	return new Map()
}

export function canSwapNow(state: State, playerId: SM.PlayerId): boolean {
	return !state.swapping && !state.pendingSwaps.has(playerId)
}

export function canQueue(state: State, playerId: SM.PlayerId): boolean {
	return !state.swapping && !state.pendingSwaps.has(playerId) && !state.editedSwaps.has(playerId)
}

export function allCanSwapNow(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.every(id => canSwapNow(state, id))
}

export function allCanQueue(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.every(id => canQueue(state, id))
}

export function someCanQueue(state: State, playerIds: SM.PlayerId[]): boolean {
	return playerIds.some(id => canQueue(state, id))
}

export function canExecuteSavedTeamswaps(state: State): boolean {
	return (
		state.editedSwaps === state.savedSwaps
		&& state.savedSwaps.size > 0
		&& !state.swapping
		&& state.pendingSwaps.size === 0
	)
}

export function isSwapPending(state: State, playerId: SM.PlayerId): boolean {
	return state.pendingSwaps.has(playerId)
}

export type Message = {
	type: 'error'
	message: string
}

export type State = {
	editedSwaps: TeamswapCollection
	players: PlayerCollection
	savedSwaps: TeamswapCollection
	pendingSwaps: TeamswapCollection
	swapping: boolean
	// who triggered the in-flight execution, null when it was the map roll (or nothing is executing). the sources on
	// the swaps themselves say who *queued* each player, which is a different question and a different admin
	swappingSource: USR.GuiOrChatUserId | null
	// the op that started the in-flight execution. lets a background watcher tell "the execution I started is still
	// pending" from "it already resolved, or a different one is running now"
	swappingOpId: string | null
}

export function initState(savedSwaps?: TeamswapCollection): State {
	return {
		editedSwaps: initTeamswapCollection(),
		savedSwaps: savedSwaps ?? initTeamswapCollection(),
		pendingSwaps: initTeamswapCollection(),
		players: new Map(),
		swapping: false,
		swappingSource: null,
		swappingOpId: null,
	}
}

export const TEAMSWAP_CANCEL_REASON = z.enum(['player-left', 'player-changed-teams'])

export const OpSchema = z.discriminatedUnion('code', [
	z.object({
		opId: z.string(),
		code: z.literal('add-player-teamswap'),
		saved: z.boolean(),
		source: USR.GuiOrChatUserIdSchema,
		playerId: SM.PlayerIdSchema,
		toTeam: MH.NormedTeamIdSchema,
	}),
	z.object({
		opId: z.string(),
		code: z.literal('init-saved-teamswaps'),
		swaps: TeamswapCollectionSchema,
	}),
	z.object({
		opId: z.string(),
		code: z.literal('remove-player-teamswaps'),
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
	z.object({ opId: z.string(), code: z.literal('clear-teamswaps'), save: z.boolean(), source: USR.GuiOrChatUserIdSchema.optional() }),

	z.object({ opId: z.string(), code: z.literal('save'), source: USR.GuiOrChatUserIdSchema }),
	z.object({ opId: z.string(), code: z.literal('execute-teamswaps'), source: USR.GuiOrChatUserIdSchema.optional() }),

	z.object({
		opId: z.string(),
		code: z.literal('swap-now'),
		swaps: TeamswapCollectionSchema,
		source: USR.GuiOrChatUserIdSchema,
	}),

	z.object({ opId: z.string(), code: z.literal('teamswap-execution-completed') }),

	z.discriminatedUnion('reason', [
		z.object({ opId: z.string(), code: z.literal('teamswap-execution-failed'), reason: z.literal('error'), message: z.string() }),
		z.object({
			opId: z.string(),
			code: z.literal('teamswap-execution-failed'),
			reason: z.literal('not-all-players-swapped'),
			playerIds: z.array(z.string()),
		}),
		// the execution never resolved: the swaps were fired but the teams never came back showing them applied
		z.object({ opId: z.string(), code: z.literal('teamswap-execution-failed'), reason: z.literal('timeout') }),
	]),
])

export type Op = z.infer<typeof OpSchema>
export type NewClientOp = DistributiveOmit<Op, 'opId'>

export function createOpId() {
	return createId(6)
}
type SwappingMutationOp =
	| 'remove-player-teamswaps'
	| 'revert-to-saved'
	| 'clear-teamswaps'
	| 'save'
	| 'player-changed-team'
	| 'player-left'

namespace OpErrors {
	export type CurrentlySwapping = { code: 'err:currently-swapping' }
	export type CurrentlyNotSwapping = { code: 'err:currently-not-swapping' }
	export type PendingSwap = { code: 'err:pending-swap'; playerId: SM.PlayerId }
	export type AlreadyMarked = { code: 'err:already-marked'; playerId: SM.PlayerId }
	export type SwapsNotSaved = { code: 'err:swaps-not-saved' }
	export type NothingQueued = { code: 'err:nothing-queued' }

	export type Unexpected = { code: 'err:unexpected'; error: unknown }
}

export type OpError<OpCode extends Op['code'] = Op['code']> =
	& { op: Extract<Op, { code: OpCode }> }
	& (
		| OpErrors.Unexpected
		| (OpCode extends 'add-player-teamswap' ? (OpErrors.CurrentlySwapping | OpErrors.AlreadyMarked)
			: OpCode extends 'clear-teamswaps' ? (OpErrors.CurrentlySwapping | OpErrors.PendingSwap | OpErrors.NothingQueued)
			: OpCode extends SwappingMutationOp ? (OpErrors.CurrentlySwapping | OpErrors.PendingSwap)
			// teamswap-execution-failed never errors: it reports through a side effect, since rejecting the batch
			// would discard the very state change (cancelling the pending swaps) that it exists to make
			: OpCode extends 'teamswap-execution-completed' ? (OpErrors.CurrentlyNotSwapping)
			: OpCode extends 'execute-teamswaps' ? (OpErrors.CurrentlySwapping | OpErrors.SwapsNotSaved)
			: OpCode extends 'swap-now' ? OpErrors.CurrentlySwapping
			: OpCode extends 'init-saved-teamswaps' ? OpErrors.CurrentlySwapping
			: never)
	)

// the typed payload carried by a RejectedError thrown from the reducer: either a specific op failure
// the dispatcher should surface, or a benign no-op that changed nothing (nothing to report)
export type Rejection = OpError | { code: 'noop' }

// what drove a change to the saved (queued) teamswaps:
//  - 'user-edit': an admin saved, queued, or cleared swaps (gui or chat command)
//  - 'executed': the saved queue was executed and drained (map roll, or a manual execute)
//  - 'swapped-now': a player was swapped immediately, which drops them from the queue if they were in it. the
//    swap itself is the action here, not the queue change, and it's already recorded as a TEAM_CHANGE_FORCED
//  - 'roster-change': a queued player left or changed teams on their own, so their swap no longer applies
export const SaveTriggerSchema = z.enum(['user-edit', 'executed', 'swapped-now', 'roster-change'])
export type SaveTrigger = z.infer<typeof SaveTriggerSchema>

export type SideEffect =
	| {
		code: 'notify-upcoming-teamswaps'
		players: SM.PlayerId[]
	}
	| {
		code: 'notify-teamswaps-cancelled'
		players: SM.PlayerId[]
	}
	| {
		code: 'execute-teamswaps'
		opId: string
		swaps: TeamswapCollection
	}
	| {
		code: 'save'
		swaps: TeamswapCollection
		prevSaved: TeamswapCollection
		source?: USR.GuiOrChatUserId
		trigger: SaveTrigger
	}
	| {
		code: 'teamswaps-executed'
		swapCount: number
		source?: USR.GuiOrChatUserId
	}
	| {
		code: 'teamswap-execution-failed'
		reason: 'error' | 'not-all-players-swapped' | 'timeout'
		// for 'error'
		message?: string
		// for 'not-all-players-swapped': the players still on the wrong team
		playerIds?: SM.PlayerId[]
		source?: USR.GuiOrChatUserId
	}
	| {
		code: 'end-all-teamswap-editing'
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
	// restoring saved swaps from the db isn't a new marking -- those players were already warned before the
	// restart. no op that can be batched alongside init-saved-teamswaps adds saved swaps, so suppressing
	// for the whole batch loses nothing.
	let skipNotifyUpcoming = false
	let saveSource: USR.GuiOrChatUserId | undefined
	// what drove the change to savedSwaps, for the TEAMSWAPS_UPDATED app event. set by every op that mutates
	// it; a batch only ever mixes ops of one kind (a roster event, or one user action)
	let saveTrigger: SaveTrigger | undefined
	for (const op of ops) {
		let opFailed = false
		const emitOpError = <T extends Op>(error: OpError<T['code']>) => {
			opFailed = true
			firstError ??= error
		}
		try {
			// swap mutations
			switch (op.code) {
				case 'add-player-teamswap': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}
					// a saved write is only in conflict with what's actually queued: another client's unsaved mark for
					// this player isn't a swap yet, so it mustn't fail an admin's chat command
					const marked = op.saved ? state.savedSwaps : state.editedSwaps
					if (marked.has(op.playerId)) {
						emitOpError({ code: 'err:already-marked', playerId: op.playerId, op })
						break
					}
					const swapEntry = { toTeam: op.toTeam, source: op.source }
					if (op.saved) {
						writeToSaved(state, swaps => swaps.set(op.playerId, swapEntry))
						saveSource = op.source
						saveTrigger = 'user-edit'
					} else {
						state.editedSwaps = new Map(state.editedSwaps)
						state.editedSwaps.set(op.playerId, swapEntry)
					}
					break
				}

				case 'init-saved-teamswaps': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}
					state.savedSwaps = new Map(state.savedSwaps)
					skipEmitSave = true
					skipNotifyUpcoming = true
					// a swap that's no longer applicable (the player left, or is already on the target team) is
					// dropped, and dropping any means the pruned collection has to be re-saved
					saveTrigger = 'roster-change'
					for (const [playerId, swapEntry] of op.swaps.entries()) {
						const team = state.players.get(playerId)
						if (team && team !== swapEntry.toTeam) state.savedSwaps.set(playerId, swapEntry)
						else {
							skipEmitSave = false
						}
					}
					break
				}

				case 'remove-player-teamswaps': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}

					if (state.pendingSwaps.has(op.playerId)) {
						emitOpError({ code: 'err:pending-swap', playerId: op.playerId, op })
						break
					}

					if (op.saved) {
						if (state.savedSwaps.has(op.playerId)) {
							emit({ code: 'notify-teamswaps-cancelled', players: [op.playerId] })
						}
						// the delete has to reach editedSwaps too, or the player stays marked there and can never be
						// re-added (add-player-teamswap would reject them as already-marked)
						writeToSaved(state, swaps => swaps.delete(op.playerId))
						saveSource = op.source
						saveTrigger = 'user-edit'
					} else {
						state.editedSwaps = new Map(state.editedSwaps)
						state.editedSwaps.delete(op.playerId)
					}
					break
				}

				case 'revert-to-saved': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}
					state.editedSwaps = state.savedSwaps
					break
				}

				case 'clear-teamswaps': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}
					if (op.save) {
						// clearing the queue only clears what's queued: unsaved marks another client is still working on
						// were never swaps, so they're left in the edit set rather than discarded
						const playerIds = Array.from(state.savedSwaps.keys())
						if (playerIds.length === 0) {
							emitOpError({ code: 'err:nothing-queued', op })
							break
						}
						emit({ code: 'notify-teamswaps-cancelled', players: playerIds })
						writeToSaved(state, swaps => MapUtils.bulkDelete(swaps, ...playerIds))
						if (op.source) saveSource = op.source
						saveTrigger = 'user-edit'
					} else {
						state.editedSwaps = initTeamswapCollection()
					}
					break
				}

				case 'execute-teamswaps': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}
					if (op.source && !Obj.deepEqual(state.editedSwaps, state.savedSwaps)) {
						emitOpError({ code: 'err:swaps-not-saved', op })
						break
					}
					if (state.savedSwaps.size === 0) {
						break
					}
					state.swapping = true
					state.swappingSource = op.source ?? null
					state.swappingOpId = op.opId
					state.pendingSwaps = state.savedSwaps
					const swaps = state.savedSwaps
					state.savedSwaps = state.editedSwaps = initTeamswapCollection()
					saveTrigger = 'executed'
					saveSource = op.source
					emit({ code: 'execute-teamswaps', opId: op.opId, swaps })
					break
				}

				case 'teamswap-execution-completed': {
					if (!state.swapping) {
						emitOpError({ code: 'err:currently-not-swapping', op })
						break
					}
					const swapCount = state.pendingSwaps.size
					const executionSource = state.swappingSource ?? undefined
					state.swappingSource = null
					state.swappingOpId = null
					state.swapping = false
					state.pendingSwaps = initTeamswapCollection()
					emit({ code: 'teamswaps-executed', swapCount, source: executionSource })
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
					const _swap = state.editedSwaps.get(op.playerId)

					if (state.swapping) {
						break
					}
					if (_swap && _swap.toTeam === op.toTeam) {
						state.editedSwaps = new Map(state.editedSwaps)
						state.editedSwaps.delete(op.playerId)
					}

					const savedSwap = state.savedSwaps.get(op.playerId)
					if (savedSwap && savedSwap.toTeam === op.toTeam) {
						state.savedSwaps = new Map(state.savedSwaps)
						state.savedSwaps.delete(op.playerId)
						saveTrigger = 'roster-change'
					}

					break
				}

				case 'player-left': {
					state.players = new Map(state.players)
					state.players.delete(op.playerId)
					if (state.swapping) {
						break
					}

					const savedSwap = state.savedSwaps.get(op.playerId)
					if (savedSwap) {
						state.savedSwaps = new Map(state.savedSwaps)
						state.savedSwaps.delete(op.playerId)
						saveTrigger = 'roster-change'
					}
					break
				}

				case 'reset-players': {
					let newSavedSwaps: State['savedSwaps'] | undefined
					let newSwaps: State['editedSwaps'] | undefined
					const allPlayerIds = new Set([...op.players.keys(), ...state.players.keys()])
					for (const playerId of allPlayerIds) {
						const nextPlayerTeam = op.players.get(playerId)
						const currentPlayerTeam = state.players.get(playerId)
						if (nextPlayerTeam && nextPlayerTeam === currentPlayerTeam) continue

						if (state.swapping) continue
						const savedSwap = state.savedSwaps.get(playerId)
						if (savedSwap) {
							newSavedSwaps ??= new Map(state.savedSwaps)
							newSavedSwaps.delete(playerId)
						}
						let editedSwap = state.editedSwaps.get(playerId)
						if (editedSwap) {
							newSwaps ??= new Map(state.editedSwaps)
							newSwaps.delete(playerId)
						}
					}
					if (newSavedSwaps !== undefined) {
						state.savedSwaps = newSavedSwaps
						saveTrigger = 'roster-change'
					}
					if (newSwaps !== undefined) state.editedSwaps = newSwaps
					state.players = op.players
					break
				}

				case 'save': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}
					// newly marked players are notified by the generic savedSwaps diff below; cancellations are
					// per-op, since a swap dropped because the player left or already changed teams shouldn't warn
					const { removed } = getTeamswapChanges(state.editedSwaps, state.savedSwaps)
					state.savedSwaps = state.editedSwaps
					saveSource = op.source
					saveTrigger = 'user-edit'
					if (removed.length > 0) emit({ code: 'notify-teamswaps-cancelled', players: removed })
					break
				}

				case 'teamswap-execution-failed': {
					// a failure is reported as a side effect rather than an op error on purpose: an op error rejects the
					// batch, and a rejected batch changes no state (see ODSM.Applied), so the pending swaps this op
					// exists to cancel would survive it and stay pending forever
					if (!state.swapping) break
					const source = state.swappingSource ?? undefined
					state.pendingSwaps = initTeamswapCollection()
					state.swapping = false
					state.swappingSource = null
					state.swappingOpId = null
					emit({
						code: 'teamswap-execution-failed',
						reason: op.reason,
						message: op.reason === 'error' ? op.message : undefined,
						playerIds: op.reason === 'not-all-players-swapped' ? op.playerIds : undefined,
						source,
					})
					break
				}

				case 'swap-now': {
					if (state.swapping) {
						emitOpError({ code: 'err:currently-swapping', op })
						break
					}

					// swapping a player now takes them out of the queue on both sets, but leaves the rest of an
					// in-flight edit (and its in-sync-ness) intact
					writeToSaved(state, swaps => MapUtils.bulkDelete(swaps, ...op.swaps.keys()))
					saveTrigger = 'swapped-now'
					saveSource = op.source

					state.pendingSwaps = op.swaps
					state.swapping = true
					state.swappingSource = op.source
					state.swappingOpId = op.opId
					emit({ code: 'execute-teamswaps', opId: op.opId, swaps: op.swaps })

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

	if (state.savedSwaps !== oldState.savedSwaps && !skipEmitSave) {
		// only players who weren't already marked for this team are newly swapping. every mutation of
		// savedSwaps lands here, including prunes (player-left, player-changed-team, reset-players) and
		// swap-now, so warning anything but the actual diff re-warns players who are already marked.
		const newSwappingPlayers: SM.PlayerId[] = []
		for (const [playerId, _swap] of state.savedSwaps.entries()) {
			const prevToTeam = oldState.savedSwaps.get(playerId)?.toTeam
			if (prevToTeam === _swap.toTeam) continue
			newSwappingPlayers.push(playerId)
		}
		emit({
			code: 'save',
			swaps: state.savedSwaps,
			prevSaved: oldState.savedSwaps,
			source: saveSource,
			trigger: saveTrigger ?? 'user-edit',
		})
		if (!skipNotifyUpcoming && newSwappingPlayers.length > 0) {
			emit({ code: 'notify-upcoming-teamswaps', players: newSwappingPlayers })
		}
	}

	// editedSwaps is shared server state, so resolving it (save, revert, clear, execute) resolves it for
	// everyone at once: nobody is left with pending edits, and so nobody is left editing. reference equality is
	// the established synced signal (see canExecuteSavedTeamswaps)
	if (state.editedSwaps === state.savedSwaps && oldState.editedSwaps !== oldState.savedSwaps) {
		emit({ code: 'end-all-teamswap-editing' })
	}

	// the reducer mutates a shallow copy, reassigning a field only when it actually changes it, so
	// reference-equal fields mean the batch produced no net change -- a benign no-op we reject so it's
	// dropped rather than broadcast.
	const unchanged = state.editedSwaps === oldState.editedSwaps
		&& state.savedSwaps === oldState.savedSwaps
		&& state.pendingSwaps === oldState.pendingSwaps
		&& state.players === oldState.players
		&& state.swapping === oldState.swapping
	if (unchanged) throw new ODSM.RejectedError<Rejection>({ code: 'noop' })

	return [state, sideEffects]
}

export type UpdateForClient = ODSM.ClientUpdate<State, Op, Rejection['code']>
