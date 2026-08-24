import { desc, inArray } from 'drizzle-orm'
import * as Rx from 'rxjs'
import * as z from 'zod'

import * as RxExt from 'slm/lib/rxjs-ext'
import * as MH from 'slm/models/match-history'
import type * as P from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Rpc from 'slm/plugin/rpc.server'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as AppEventsSys from 'slm/systems/app-events'
import * as MatchHistory from 'slm/systems/match-history'
import * as Reminders from 'slm/systems/post-roll-reminders'

import type manifest from './plugin.ts'
import * as S from './schema.ts'
import * as TR from './triggers.ts'

type Ctx = P.ServerCtx<typeof manifest>

// pulses a serverId whenever that server's trigger events change
const update$ = new Rx.Subject<string>()

const os = Rpc.os<typeof manifest>()

// the plugin's rpc surface. client.tsx builds its client from `typeof router`, so nothing there is
// annotated by hand. An async generator handler is a stream.
export const router = {
	// a watch stream, not a one-shot: emits current events on subscribe and re-reads on each pulse
	// events plus the match they should be described against: which side a normalized team is reads
	// differently per match, and the dashboard alert speaks about the one being played
	activeEvents: os.input(z.object({})).handler(async function* ({ context }) {
		const events$ = Rx.merge(Rx.of(context.serverId), update$).pipe(
			Rx.filter((serverId) => serverId === context.serverId),
			Rx.switchMap(async () => {
				const history = await MatchHistory.getRecentMatches(context)
				const current = await MatchHistory.getCurrentMatch(context)
				// the alert speaks about the match just played, so it needs to know which that was: every
				// event still in the session is streamed, because the match history decorates all of them
				const lastPlayed = history.findLast((m) => m.status === 'post-game')
				return {
					events: await activeEvents(context),
					current: current ? { layerId: current.layerId, ordinal: current.ordinal } : null,
					lastPlayedMatchId: lastPlayed?.historyEntryId ?? null,
				}
			}),
		)
		yield* RxExt.toAsyncGenerator(events$)
	}),
}

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Rpc.register(ctx, router)

	Servers.setup(ctx, (sctx, cleanup) => {
		cleanup.push(
			sctx.matchHistory.finalized$
				.pipe(
					Instr.durableSub('evaluate', { module: sctx.module }, async ({ matchId }) => {
						await evaluate(sctx, matchId)
					}),
				)
				.subscribe(),
		)
	})

	// asked after each roll: one line per trigger still active, named for the match about to be played
	Reminders.register(ctx, async (sctx) => {
		if (!PluginConfig.get(sctx).postRollReminder) return []
		const current = await MatchHistory.getCurrentMatch(sctx)
		if (!current) return []
		const parity = MH.getTeamParityForOffset(current, 0)
		return (await activeEvents(sctx)).map((event) => render(event, parity))
	})
}

async function evaluate(ctx: Ctx, matchId: number | null) {
	const cfg = PluginConfig.get(ctx)
	const history = await MatchHistory.getRecentMatches(ctx)
	if (history.length === 0) return

	let fired = false
	for (const trigger of TR.TRIGGERS) {
		const level = cfg.levels[trigger.id as keyof typeof cfg.levels]
		if (level === 'off') continue
		// one throwing trigger must not stop the others
		try {
			const result = trigger.evaluate({ history })
			if (!result) continue
			await ctx
				.db()
				.insert(S.triggerEvents)
				.values({
					matchTriggeredId: matchId,
					triggerId: trigger.id,
					triggerVersion: trigger.version,
					level,
					message: result.message,
					strongerTeam: result.strongerTeam,
					input: result.relevantInput.history.map((m) => m.historyEntryId),
					time: new Date(),
				})
			await AppEventsSys.emit(
				ctx,
				'trigger-fired',
				{ triggerId: trigger.id, level, strongerTeam: result.strongerTeam },
				`balance trigger ${trigger.name}: ${result.message.replace('{{strongerTeam}}', `Team ${MH.toNormedTeamId(result.strongerTeam)}`)}`,
			)
			fired = true
		} catch (err) {
			ctx.log.error(err, 'trigger %s evaluation failed', trigger.id)
		}
	}
	if (fired) update$.next(ctx.serverId)
}

// trigger events belonging to the current session's matches, newest first
async function activeEvents(ctx: Ctx): Promise<S.TriggerEvent[]> {
	const session = TR.sessionSlice(await MatchHistory.getRecentMatches(ctx), 20)
	const ids = session.map((m) => m.historyEntryId)
	if (ids.length === 0) return []
	return await ctx
		.db()
		.select()
		.from(S.triggerEvents)
		.where(inArray(S.triggerEvents.matchTriggeredId, ids))
		.orderBy(desc(S.triggerEvents.time))
}

function render(event: S.TriggerEvent, parity: number): string {
	const trigger = TR.TRIGGERS.find((t) => t.id === event.triggerId)
	const team = MH.getDenormedTeamId(MH.toNormedTeamId(event.strongerTeam as MH.NormedTeamProp), parity)
	return `[balance] ${trigger?.name ?? event.triggerId}: currently favours Team ${team}`
}
