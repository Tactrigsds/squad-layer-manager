import * as Arr from '@/lib/array'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import * as SM from '@/models/squad.models'
import * as Teamswitches from '@/models/teamswitches.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as MatchHistory from '@/systems/match-history.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'

import * as Rx from 'rxjs'

export const module = initModule('teamswitches')

let log!: CS.Logger

type Session = RbSyncState.Server.Session<Teamswitches.Op, Teamswitches.State, Teamswitches.SideEffects>

export type TeamswitchContext = {
	session: Session
	// outgoing operations
	op$: Rx.Subject<Teamswitches.Op>
}
export function setup() {
	log = module.getLogger()
}

export function initContext(ctx: C.SquadServer & C.ServerSliceCleanup) {
	const serverId = ctx.serverId
	const sideEffectQueue$ = new Rx.Subject<[C.ServerSlice & C.Db, Teamswitches.SideEffects]>()
	ctx.cleanup.push(sideEffectQueue$)
	const context: TeamswitchContext = {
		session: RbSyncState.Server.initSession(Teamswitches.initState(), {
			onSideEffect: (sideEffect) => {
				const ctx = resolveCtx(serverId)
				sideEffectQueue$.next([ctx, sideEffect])
			},
		}),
		op$: new Rx.Subject<Teamswitches.Op>(),
	}
	sideEffectQueue$.pipe(C.durableSub('onSideEffect', { module }, (args) => onSideEffect(...args))).subscribe()
	ctx.cleanup.push(context.op$)

	ctx.server.event$.pipe(
		Rx.filter(([ctx, e]) => Arr.includes(PendingEvents.TeamModifyingEventTypes.options, e.type) && e.type !== 'PLAYER_CONNECTED'),
		C.durableSub('checkTeamswitchStatuses', { module }, async ([ctx, e]) => {
			const players = ctx.server.eventState.currTeams?.players
			if (!players) return
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			const delta = Teamswitches.getTeamswitchStatusDelta(ctx.teamswitches.session.state, players, currentMatch.ordinal)
			if (delta) {
				await onOperation(ctx, { code: 'set-switch-statuses', delta, opId: Teamswitches.newOpId() })
			}
		}),
	).subscribe()

	return context
}

const orpcBase = getOrpcBase(module)
export const orpcRouter = {
	watchOps: orpcBase.handler(async function* watchOps({ context, signal }) {
		const obs = SquadServer.selectedServerCtx$(context).pipe(
			withAbortSignal(signal!),
			Rx.switchMap((ctx) => ctx.teamswitches.op$),
		)
		yield* toAsyncGenerator(obs)
	}),

	// TODO we need to filter errors back to the client that might have occured while handling side-effects
	dispatchOp: orpcBase.meta({ type: 'mutation' }).input(Teamswitches.OpSchema).handler(async ({ context, input }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(context)
		await onOperation(ctx, input)
	}),
}

async function onOperation(ctx: C.Teamswitch, op: Teamswitches.Op) {
	ctx.teamswitches.session = RbSyncState.Server.applyOps(ctx.teamswitches.session, [op], Teamswitches.reducer)
}

async function onSideEffect(
	ctx: C.Teamswitch & C.Db & C.SquadServer & C.MatchHistory & C.Rcon & C.AdminList & C.LayerQueue,
	sideEffect: Teamswitches.SideEffects,
) {
	switch (sideEffect.code) {
		case 'switches-mutated': {
			const players = ctx.server.eventState.currTeams?.players
			if (!players) return
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			const delta = Teamswitches.getTeamswitchStatusDelta(ctx.teamswitches.session.state, players, currentMatch.ordinal)
			if (delta) {
				await onOperation(ctx, { code: 'set-switch-statuses', delta, opId: Teamswitches.newOpId() })
			}
			break
		}

		case 'executing-teamswitch': {
			if (sideEffect.switches.size === 0) return
			const teamsRes = await ctx.server.teams.get(ctx, { ttl: 500 })
			if (teamsRes.code !== 'ok') {
				log.error('failed to get teams: %s :: %s', teamsRes.code, teamsRes.msg)
				return
			}
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			const players = teamsRes.players
			const toSwitch: SM.PlayerId[] = []
			for (const [playerId, teamswitch] of sideEffect.switches.entries()) {
				const player = SM.PlayerIds.find(players, p => p.ids, playerId)
				if (!player) {
					log.warn('player %s not found, skipping switch', playerId)
					continue
				}
				const toTeamId = MH.getDenormedTeamId(teamswitch.toTeam, currentMatch.ordinal)
				if (player.teamId === toTeamId) {
					log.warn('player %s is already on team %s, skipping switch', SM.PlayerIds.prettyPrint(player.ids), toTeamId)
					continue
				}
				log.info('switching player %s to team %s (%s)', SM.PlayerIds.prettyPrint(player.ids), toTeamId, teamswitch.toTeam)
				toSwitch.push(playerId)
			}
			await SquadRcon.switchPlayers(ctx, toSwitch)
			await DB.runTransaction(ctx, async (ctx) => {
				await SquadServer.updateServerState(ctx, { teamswitches: new Map() }, { type: 'system', event: 'teamswitches-executed' })
			})
			await onOperation(ctx, { code: 'complete-teamswitch-execution', opId: Teamswitches.newOpId() })
			log.info('switched %s players', toSwitch.length)
			break
		}

		case 'saving': {
			const statuses = sideEffect.statuses
			for (const [playerId, teamswitch] of sideEffect.switches.entries()) {
				const status = statuses.get(playerId)
				if (status !== 'ready') continue
				if (!sideEffect.prevSaved.has(playerId)) {
					void SquadRcon.warn(ctx, playerId, messages.notifyPlayerOfTeamswitch())
				}
			}
			await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
				await SquadServer.updateServerState(ctx, { teamswitches: sideEffect.switches }, { type: 'system', event: 'teamswitches-saved' })
			})
			break
		}

		case 'error': {
			log.error(sideEffect.error, 'error while handling teamswitch side effect')
			break
		}

		default:
			assertNever(sideEffect)
	}
}

function resolveCtx(serverId: string) {
	return SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
}

function getBaseCtx() {
	return DB.addPooledDb(CS.init())
}

const messages = {
	notifyPlayerOfTeamswitch: () => {
		return 'You have been marked for teamswitching on mapchange. '
			+ 'Thank you for helping with team balance and contact admins if you have issues.'
	},
}
