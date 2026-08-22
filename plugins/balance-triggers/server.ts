import { desc, inArray } from 'drizzle-orm'
import * as Rx from 'slm/lib/rxjs'
import * as MH from 'slm/models/match-history'
import type * as P from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Rpc from 'slm/plugin/rpc.server'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as Logger from 'slm/server/logger'
import * as AppEventsSys from 'slm/systems/app-events'
import * as LayerQueue from 'slm/systems/layer-queue'
import * as MatchHistory from 'slm/systems/match-history'
import * as SquadRcon from 'slm/systems/squad-rcon'
import * as z from 'zod'

import manifest from './plugin.ts'
import * as S from './schema.ts'
import * as TR from './triggers.ts'

type Ctx = P.ServerCtx<typeof manifest>

const module = Logger.initModule('plugin:balance-triggers')

// pulses a serverId whenever that server's trigger events change
const update$ = new Rx.Subject<string>()

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Servers.setup(ctx, (sctx, cleanup) => {
		cleanup.push(
			sctx.matchHistory.finalized$
				.pipe(
					Instr.durableSub('balance-triggers:evaluate', { module }, async ({ matchId }) => {
						await evaluate(sctx, matchId)
					}),
				)
				.subscribe(),
		)
	})

	LayerQueue.addPostRollReminder(ctx, async (sctx) => {
		if (!PluginConfig.get(sctx).postRollReminder) return
		const current = await MatchHistory.getCurrentMatch(sctx)
		if (!current) return
		const top = TR.highestPriority(await activeEvents(sctx))
		if (!top) return
		await SquadRcon.warnAllAdmins(sctx, render(top, current))
	})

	// a watch stream, not a one-shot: emits current events on subscribe and re-reads on each pulse
	Rpc.stream(ctx, 'activeEvents', z.object({}), (sctx) =>
		Rx.merge(Rx.of(sctx.serverId), update$).pipe(
			Rx.filter((serverId) => serverId === sctx.serverId),
			Rx.switchMap(() => activeEvents(sctx)),
		))
}

async function evaluate(ctx: Ctx, matchId: number | null) {
	const cfg = PluginConfig.get(ctx)
	const history = (await MatchHistory.getRecentMatches(ctx)).filter(TR.isPostGame)
	if (history.length === 0) return

	let fired = false
	for (const trigger of TR.TRIGGERS) {
		const level = cfg.levels[trigger.id as keyof typeof cfg.levels]
		if (level === 'off') continue
		// one throwing trigger must not stop the others
		try {
			const result = trigger.evaluate({ history })
			if (!result) continue
			await ctx.db().insert(S.triggerEvents).values({
				matchTriggeredId: matchId,
				triggerId: trigger.id,
				triggerVersion: trigger.version,
				level,
				strongerTeam: result.strongerTeam,
				input: result.relevantInput.history.map((m) => m.historyEntryId),
				time: new Date(),
			})
			await AppEventsSys.emit(
				ctx,
				'trigger-fired',
				{ triggerId: trigger.id, level, strongerTeam: result.strongerTeam },
				`balance trigger ${trigger.name}: one side ${result.message}`,
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
	const history = (await MatchHistory.getRecentMatches(ctx)).filter(TR.isPostGame)
	const session = TR.sessionSlice(history, 20)
	const ids = session.history.map((m) => m.historyEntryId)
	if (ids.length === 0) return []
	return await ctx
		.db()
		.select()
		.from(S.triggerEvents)
		.where(inArray(S.triggerEvents.matchTriggeredId, ids))
		.orderBy(desc(S.triggerEvents.time))
}

function render(event: S.TriggerEvent, current: MH.MatchDetails): string {
	const trigger = TR.TRIGGERS.find((t) => t.id === event.triggerId)
	const parity = MH.getTeamParityForOffset(current, 0)
	const team = MH.getDenormedTeamId(MH.toNormedTeamId(event.strongerTeam as MH.NormedTeamProp), parity)
	return `[balance] ${trigger?.name ?? event.triggerId}: currently favours Team ${team}`
}
