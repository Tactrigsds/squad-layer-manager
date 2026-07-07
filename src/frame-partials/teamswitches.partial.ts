import type * as FRM from '@/lib/frame'
import * as ODSM from '@/lib/odsm'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswitches.models'
import type * as UP from '@/models/user-presence'
import * as RPC from '@/orpc.client'
import * as UsersClient from '@/systems/users.client'
import * as Rx from 'rxjs'

export type Store = {
	teamswitches: TeamswitchSlice
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { teamswitches: Key }
export type TeamswitchSlice = {
	serverId: string
	session: ODSM.Client.Session<TSW.Op, TSW.State>
	// user-attributed teamswitch ops that landed on the synced timeline, for transient presence-panel event text
	presenceEvent$: Rx.Subject<UP.PresenceEvent>
	onUpdate(update: TSW.UpdateForClient): void
}

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store>

async function resolveDisplayName(source: TSW.Teamswitch['source'] | undefined): Promise<string> {
	const discordId = source?.discordId
	if (!discordId) return 'Someone'
	try {
		const res = await RPC.queryClient.fetchQuery(UsersClient.getFetchUserOptions(discordId))
		return res?.code === 'ok' ? res.user.displayName : 'Someone'
	} catch {
		return 'Someone'
	}
}

// surfaces a rejected teamswitch op to the user. called at dispatch time with the rejection the
// reducer threw, so it already runs on the originating client -- no need to filter by user
function toastOpError(error: TSW.OpError) {
	let title: string
	let description: string | undefined
	switch (error.code) {
		case 'err:currently-switching':
			title = 'Switch in progress'
			description = 'Cannot modify switches while a team switch is being executed.'
			break
		case 'err:switches-not-saved':
			title = 'Switches not saved'
			description = 'Save your switches before executing.'
			break
		case 'err:pending-switch':
			title = 'Player switch pending'
			description = `A switch for this player is already pending execution.`
			break
		case 'err:teamswitch-execution-failed':
			title = 'Team switch failed'
			description = error.reason === 'not-all-players-switched'
				? 'Some players could not be switched to their assigned teams.'
				: 'An error occurred while executing the team switch.'
			break
		case 'err:currently-not-switching':
		case 'err:unexpected':
			title = 'Unexpected error'
			description = 'An unexpected error occurred with the team switch system.'
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
			const { source, switches } = se
			if (source.discordId) presenceEvent$.next({ userId: source.discordId, action: 'saved-teamswitches' })
			void resolveDisplayName(source).then((name) => {
				const count = switches.size
				const description = count > 0
					? `${name} saved ${count} teamswitch${count !== 1 ? 'es' : ''}.`
					: `${name} cleared the saved teamswitches.`
				toast('Teamswitches saved', { description })
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
				case 'add-player-teamswitch':
					action = 'added-teamswitch'
					break
				case 'remove-player-teamswitches':
					action = 'removed-teamswitch'
					break
				case 'clear-teamswitches':
					action = 'cleared-teamswitches'
					break
				case 'revert-to-saved':
					action = 'discarded-teamswitch-edits'
					break
				case 'switch-now':
					action = 'switched-players-now'
					break
				default:
					return
			}
			const userId = 'source' in op ? op.source?.discordId : undefined
			if (userId) presenceEvent$.next({ userId, action })
			break
		}

		case 'teamswitches-executed': {
			const { source, switchCount } = se
			if (source?.discordId) presenceEvent$.next({ userId: source.discordId, action: 'executed-teamswitches' })
			void resolveDisplayName(source).then((name) => {
				const description = `${name} switched ${switchCount} player${switchCount !== 1 ? 's' : ''} to their assigned teams.`
				toast('Teamswitches executed', { description })
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

export function initTeamswitches(args: Args) {
	const set = ZusUtils.toPartialSetter(args.set, 'teamswitches')
	const get = ZusUtils.toPartialGetter(args.get, 'teamswitches')
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
						if (res.unknownOpIds.length > 0) console.warn('received ack for unknown teamswitch ops', res.unknownOpIds)
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
		} satisfies TeamswitchSlice,
	)

	args.sub.add(
		RPC.observe(() => RPC.orpc.teamswitches.watchUpdates.call({ serverId })).subscribe(update => {
			get().onUpdate(update)
		}),
	)
}

export namespace Actions {
	export function dispatch(stores: KeyProp, newOp: TSW.NewClientOp) {
		const slice = ZusUtils.toPartialStore(stores.teamswitches, 'teamswitches')
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
		void RPC.orpc.teamswitches.dispatchOp.call({ serverId: slice.getState().serverId, op })
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
