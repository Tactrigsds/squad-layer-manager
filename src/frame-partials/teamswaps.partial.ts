import type * as FRM from '@/lib/frame'
import * as ODSM from '@/lib/odsm'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswaps.models'
import type * as UP from '@/models/user-presence'
import * as RPC from '@/orpc.client'
import * as UsersClient from '@/systems/users.client'
import * as Rx from 'rxjs'

export type Store = {
	teamswaps: TeamswapSlice
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { teamswaps: Key }
export type TeamswapSlice = {
	serverId: string
	session: ODSM.Client.Session<TSW.Op, TSW.State>
	// user-attributed teamswap ops that landed on the synced timeline, for transient presence-panel event text
	presenceEvent$: Rx.Subject<UP.PresenceEvent>
	onUpdate(update: TSW.UpdateForClient): void
}

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store>

async function resolveDisplayName(source: TSW.Teamswap['source'] | undefined): Promise<string> {
	const discordId = source?.discordId
	if (!discordId) return 'Someone'
	try {
		const res = await RPC.queryClient.fetchQuery(UsersClient.getFetchUserOptions(discordId))
		return res?.code === 'ok' ? res.user.displayName : 'Someone'
	} catch {
		return 'Someone'
	}
}

// surfaces a rejected teamswap op to the user. called at dispatch time with the rejection the
// reducer threw, so it already runs on the originating client -- no need to filter by user
function toastOpError(error: TSW.OpError) {
	let title: string
	let description: string | undefined
	switch (error.code) {
		case 'err:currently-swapping':
			title = 'Swap in progress'
			description = 'Cannot modify swaps while a team swap is being executed.'
			break
		case 'err:swaps-not-saved':
			title = 'Swaps not saved'
			description = 'Save your swaps before executing.'
			break
		case 'err:pending-swap':
			title = 'Player swap pending'
			description = `A swap for this player is already pending execution.`
			break
		case 'err:nothing-queued':
			title = 'No teamswaps queued'
			description = 'There is nothing to clear.'
			break
		case 'err:currently-not-swapping':
		case 'err:unexpected':
			title = 'Unexpected error'
			description = 'An unexpected error occurred with the team swap system.'
			break
		default:
			return
	}
	toast.error(title, { description })
}

function onSideEffect(se: TSW.SideEffect, presenceEvent$: Rx.Subject<UP.PresenceEvent>) {
	switch (se.code) {
		case 'save': {
			if (!se.source) break
			const { source, swaps } = se
			if (source.discordId) presenceEvent$.next({ userId: source.discordId, action: 'saved-teamswaps' })
			void resolveDisplayName(source).then((name) => {
				const count = swaps.size
				const description = count > 0
					? `${name} saved ${count} teamswap${count !== 1 ? 's' : ''}.`
					: `${name} cleared the saved teamswaps.`
				toast('Teamswaps saved', { description })
			})
			break
		}

		// save/execute ops have dedicated side effects above; op-outcome covers the rest of the
		// user-attributed ops
		case 'op-outcome': {
			if (!se.success) break
			const op = se.op
			let action: UP.PresenceEventAction
			switch (op.code) {
				case 'add-player-teamswap':
					action = 'added-teamswap'
					break
				case 'remove-player-teamswaps':
					action = 'removed-teamswap'
					break
				case 'clear-teamswaps':
					action = 'cleared-teamswaps'
					break
				case 'revert-to-saved':
					action = 'discarded-teamswap-edits'
					break
				case 'swap-now':
					action = 'swapped-players-now'
					break
				default:
					return
			}
			const userId = 'source' in op ? op.source?.discordId : undefined
			if (userId) presenceEvent$.next({ userId, action })
			break
		}

		case 'teamswap-execution-failed': {
			const description = se.reason === 'not-all-players-swapped'
				? `${se.playerIds?.length ?? 0} player${se.playerIds?.length === 1 ? '' : 's'} could not be swapped to their assigned team.`
				: se.reason === 'timeout'
				? 'The swap never took effect on the server.'
				: se.message ?? 'An error occurred while executing the team swap.'
			toast.error('Team swap failed', { description: `${description} The pending swaps have been cancelled.` })
			break
		}

		case 'teamswaps-executed': {
			const { source, swapCount } = se
			const players = `${swapCount} player${swapCount !== 1 ? 's' : ''}`
			// no source means the map roll executed the queue: it's nobody's action, so it isn't attributed to a
			// user and doesn't put an event on anyone in the presence panel
			if (!source) {
				toast('Teamswaps executed', { description: `${players} swapped to their assigned teams on map change.` })
				break
			}
			if (source.discordId) presenceEvent$.next({ userId: source.discordId, action: 'executed-teamswaps' })
			void resolveDisplayName(source).then((name) => {
				toast('Teamswaps executed', { description: `${name} swapped ${players} to their assigned teams.` })
			})
			break
		}

		default:
			break
	}
}

function initSession(state?: TSW.State, ops?: TSW.Op[]) {
	return ODSM.Client.initSession<TSW.Op, TSW.State>(state ?? TSW.initState(), { ops })
}

export function initTeamswaps(args: Args) {
	const set = ZusUtils.toPartialSetter(args.set, 'teamswaps')
	const get = ZusUtils.toPartialGetter(args.get, 'teamswaps')
	const serverId = args.input.serverId
	const presenceEvent$ = new Rx.Subject<UP.PresenceEvent>()

	set(
		{
			serverId,
			session: initSession(),
			presenceEvent$,

			onUpdate(update) {
				switch (update.code) {
					case 'init':
						// processInit rebases in-flight pending ops onto the snapshot so the acks that follow still resolve
						set({
							session: ODSM.Client.processInit(get().session, update.state, update.ops, TSW.reducer),
						})
						break
					case 'op': {
						const res = ODSM.Client.processIncomingOps(get().session, update.ops, TSW.reducer)
						set({ session: res.session })
						if (!res.rejected) { for (const se of res.sideEffects) onSideEffect(se, presenceEvent$) }
						break
					}
					case 'ack': {
						// ops are deterministic, so the server only sends back the ids -- replay our pending copies
						const session = get().session
						const res = ODSM.Client.processAcks(session, update.opIds, TSW.reducer)
						if (res.unknownOpIds.length > 0) console.warn('received ack for unknown teamswap ops', res.unknownOpIds)
						if (res.session !== session) {
							set({ session: res.session })
							if (!res.rejected) { for (const se of res.sideEffects) onSideEffect(se, presenceEvent$) }
						}
						break
					}
					default:
						assertNever(update)
				}
			},
		} satisfies TeamswapSlice,
	)

	args.sub.add(
		RPC.observe('teamswaps.watchUpdates', () => RPC.orpc.teamswaps.watchUpdates.call({ serverId })).pipe(RPC.dropServerNotLoaded())
			.subscribe(update => {
				get().onUpdate(update)
			}),
	)
}

export namespace Actions {
	export function dispatch(stores: KeyProp, newOp: TSW.NewClientOp) {
		const slice = ZusUtils.toPartialStore(stores.teamswaps, 'teamswaps')
		const op = { ...newOp, opId: TSW.createOpId() }
		const prev = slice.getState().session
		const res = ODSM.Client.processOutgoingOps(prev, [op], TSW.reducer)
		if (res.rejected) {
			// the op was rejected against local state; surface a real failure to the user and drop it
			// without sending. a 'noop' rejection changed nothing and has nothing to report
			const rejection = res.error.data as TSW.Rejection
			if (rejection.code !== 'noop') toastOpError(rejection)
			return
		}
		slice.setState({ session: res.session })
		void RPC.orpc.teamswaps.dispatchOp.call({ serverId: slice.getState().serverId, op })
	}
}

export function getPlayerOppositeTeam(
	playerId: SM.PlayerId,
	currentMatch: MH.MatchDetails | undefined,
	players: SM.Player[],
): MH.NormedTeamId | null {
	if (!currentMatch) return null
	const player = SM.PlayerIds.find(players, p => p.ids, playerId)
	if (!player?.teamId) return null
	const normed = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
	return normed === 'A' ? 'B' : 'A'
}
