import { toast } from '@/hooks/use-toast'
import type * as FRM from '@/lib/frame'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswitches.models'
import * as RPC from '@/orpc.client'
import * as UsersClient from '@/systems/users.client'

export type Store = {
	teamswitches: TeamswitchSlice
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { teamswitches: Key }
export type TeamswitchSlice = {
	serverId: string
	session: RbSyncState.Client.Session<TSW.Op, TSW.State, TSW.SideEffect>
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

function onSideEffect(se: TSW.SideEffect) {
	switch (se.code) {
		case 'error': {
			const userId = UsersClient.loggedInUserId
			if (!userId) return
			if ((se.error.op as any).source?.discordId !== userId) return
			const { error } = se
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
			toast({ variant: 'destructive', title, description })
			break
		}

		case 'save': {
			if (!se.source) break
			const { source, switches } = se
			void resolveDisplayName(source).then((name) => {
				const count = switches.size
				const description = count > 0
					? `${name} saved ${count} teamswitch${count !== 1 ? 'es' : ''}.`
					: `${name} cleared the saved teamswitches.`
				toast({ title: 'Teamswitches saved', description })
			})
			break
		}

		case 'teamswitches-executed': {
			const { source, switchCount } = se
			void resolveDisplayName(source).then((name) => {
				const description = `${name} switched ${switchCount} player${switchCount !== 1 ? 's' : ''} to their assigned teams.`
				toast({ title: 'Teamswitches executed', description })
			})
			break
		}

		default:
			break
	}
}

function initSession(state?: TSW.State, ops?: TSW.Op[]) {
	return RbSyncState.Client.initSession<TSW.Op, TSW.State, TSW.SideEffect>(state ?? TSW.initState(), {
		onSideEffect,
		ops,
	})
}

export function initTeamswitches(args: Args) {
	const set = ZusUtils.toPartialSetter(args.set, 'teamswitches')
	const get = ZusUtils.toPartialGetter(args.get, 'teamswitches')
	const serverId = args.input.serverId

	set(
		{
			serverId,
			session: initSession(),

			onUpdate(update) {
				switch (update.code) {
					case 'init':
						// processInit rebases in-flight pending ops onto the snapshot so the acks that follow still resolve
						set({
							session: RbSyncState.Client.processInit(get().session, update.state, update.ops, TSW.reducer),
						})
						break
					case 'op': {
						const updated = RbSyncState.Client.processIncomingOps(get().session, update.ops, TSW.reducer)
						set({ session: updated })
						break
					}
					case 'ack': {
						// ops are deterministic, so the server only sends back the ids -- replay our pending copies
						const session = get().session
						const pendingIds = new Set(session.pendingOps.map(op => op.opId))
						if (!update.opIds.every(id => pendingIds.has(id))) {
							console.warn('received ack for unknown teamswitch ops', update.opIds)
							break
						}
						set({ session: RbSyncState.Client.processAckedOps(session, update.opIds, TSW.reducer) })
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
		const updated = RbSyncState.Client.processOutgoingOps(slice.getState().session, [op], TSW.reducer)
		slice.setState({ session: updated })
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
