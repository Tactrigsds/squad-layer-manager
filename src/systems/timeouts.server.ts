import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { createId } from '@/lib/id'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { formatDurationApprox, formatHumanTime } from '@/lib/zod'
import * as AAR from '@/models/admin-action-reasons.models'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared'
import * as SM from '@/models/squad.models'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as E from 'drizzle-orm'
import { z } from 'zod'

// Kick timeouts: a row is active while cancelled=false and expiresAt > now, and is enforced globally --
// players with an active timeout are re-kicked on PLAYER_CONNECTED / roster RESET on every SLM server
// (see the enforcement subscription in squad-server.server.ts).

const module = initModule('timeouts')
const orpcBase = getOrpcBase(module)

export const update$ = new IsolatedSubject<void>()

function activeWhere(playerIds?: SM.PlayerId[]) {
	return E.and(
		E.eq(Schema.timeouts.cancelled, false),
		E.gt(Schema.timeouts.expiresAt, new Date()),
		playerIds ? E.inArray(Schema.timeouts.playerId, playerIds) : undefined,
	)
}

export async function getActiveTimeouts(ctx: C.Db, playerIds: SM.PlayerId[]): Promise<SchemaModels.Timeout[]> {
	if (playerIds.length === 0) return []
	return await ctx.db().select().from(Schema.timeouts).where(activeWhere(playerIds))
}

export type ActiveTimeoutRow = SchemaModels.Timeout & {
	username: string | null
	steamId: bigint | null
	actor: AppEvents.Actor | null
	// the reason as originally delivered (rendered from the stored template + vars); null when kicked without one
	reasonMessage: string | null
}

// reconstructs the AppliedReason snapshot from a timeout row (see the reasonTemplate/reasonVars columns)
function appliedReasonFromRow(t: SchemaModels.Timeout): AAR.AppliedReason | null {
	if (t.reasonTemplate === null) return null
	return {
		label: t.reasonLabel ?? undefined,
		template: t.reasonTemplate,
		vars: (t.reasonVars as Record<string, string> | null) ?? {},
	}
}

export async function listActiveTimeouts(ctx: C.Db): Promise<ActiveTimeoutRow[]> {
	const rows = await ctx.db()
		.select({
			timeout: Schema.timeouts,
			username: Schema.players.username,
			steamId: Schema.players.steamId,
			actorType: Schema.appEvents.actorType,
			actorUserId: Schema.appEvents.actorUserId,
			actorPlayerId: Schema.appEvents.actorPlayerId,
		})
		.from(Schema.timeouts)
		.leftJoin(Schema.players, E.eq(Schema.timeouts.playerId, Schema.players.eosId))
		.leftJoin(Schema.appEvents, E.eq(Schema.timeouts.appEventId, Schema.appEvents.id))
		.where(activeWhere())
		.orderBy(E.asc(Schema.timeouts.expiresAt))
	return rows.map((row): ActiveTimeoutRow => {
		let actor: AppEvents.Actor | null = null
		if (row.actorType === 'slm-user' && row.actorUserId !== null) actor = { type: 'slm-user', userId: row.actorUserId }
		else if (row.actorType === 'ingame-user' && row.actorPlayerId !== null) actor = { type: 'ingame-user', playerId: row.actorPlayerId }
		else if (row.actorType === 'system') actor = { type: 'system' }
		const applied = appliedReasonFromRow(row.timeout)
		return {
			...row.timeout,
			username: row.username,
			steamId: row.steamId,
			actor,
			reasonMessage: applied && AAR.renderAppliedReason(applied),
		}
	})
}

// the delivered kick message when a timeout was issued without a reason
const DEFAULT_TIMEOUT_TEXT = 'You have been kicked by an admin.'

// creates the timeout (app event + row) and kicks the player from the issuing server. `reason` carries the
// unrendered template + vars (with the ORIGINAL duration); enforcement re-renders with the remaining one.
export async function kickWithTimeout(
	ctx: C.Db & C.ServerSlice & CS.AbortSignal,
	opts: { target: SM.Player; durationMs: number; actor: AppEvents.Actor; reason?: AAR.AppliedReason },
): Promise<{ code: 'ok'; timeoutId: string } | { code: 'err:already-timed-out'; msg: string }> {
	const targetId = SM.PlayerIds.getPlayerId(opts.target.ids)
	// stacking timeouts on one player is almost always a mistake (two admins reacting to the same incident);
	// the existing one must be cancelled before a new one can be issued. checked before the app event is
	// emitted so a rejected kick leaves no audit record.
	const [existing] = await getActiveTimeouts(ctx, [targetId])
	if (existing) {
		const remaining = formatDurationApprox(existing.expiresAt.getTime() - Date.now())
		return {
			code: 'err:already-timed-out',
			msg: `${
				opts.target.ids.username ?? targetId
			} already has an active timeout (expires in ${remaining}). Cancel it first to issue a new one.`,
		}
	}
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const timeoutId = createId(16)
	const expiresAt = new Date(Date.now() + opts.durationMs)
	const appEvent = AppEvents.create<AppEvents.PlayerTimedOut>({
		type: 'PLAYER_TIMED_OUT',
		actor: opts.actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		target: targetId,
		timeoutId,
		durationMs: opts.durationMs,
		expiresAt: expiresAt.getTime(),
		reason: opts.reason,
	})
	await SquadServer.emitAppEvent(ctx, appEvent)
	// player rows are normally upserted lazily by event persistence, which may not have run yet for a
	// fresh connect; ensure the FK target exists
	await ctx.db()
		.insert(Schema.players)
		.values({
			eosId: targetId,
			steamId: opts.target.ids.steam ? BigInt(opts.target.ids.steam) : undefined,
			username: opts.target.ids.username ?? targetId,
		})
		.onConflictDoNothing({ target: Schema.players.eosId })
	await ctx.db().insert(Schema.timeouts).values({
		id: timeoutId,
		playerId: targetId,
		expiresAt,
		appEventId: appEvent.id,
		issuedServerId: ctx.serverId,
		reasonLabel: opts.reason?.label ?? null,
		reasonTemplate: opts.reason?.template ?? null,
		reasonVars: opts.reason?.vars ?? null,
	})
	const message = opts.reason ? AAR.renderAppliedReason(opts.reason) : DEFAULT_TIMEOUT_TEXT
	await SquadServer.kickPlayerAction(ctx, targetId, { type: 'event', id: appEvent.id }, message)
	await SquadServer.notifyAdminsOfWebAction(ctx, appEvent)
	update$.next()
	return { code: 'ok', timeoutId }
}

// sets the cancelled flag and records the cancellation. sliceCtx (when the cancellation originates in-game)
// routes the app event into that server's activity feed; otherwise it is audit-only.
export async function cancelTimeout(
	ctx: C.Db,
	opts: { timeoutId: string; actor: AppEvents.Actor; sliceCtx?: C.Db & C.SquadServer & C.MatchHistory & CS.AbortSignal },
): Promise<{ code: 'ok' } | { code: 'err:not-found'; msg: string }> {
	const [timeout] = await ctx.db().select().from(Schema.timeouts).where(
		E.and(E.eq(Schema.timeouts.id, opts.timeoutId), activeWhere()),
	)
	if (!timeout) return { code: 'err:not-found', msg: 'No active timeout found' }
	await ctx.db().update(Schema.timeouts).set({ cancelled: true }).where(E.eq(Schema.timeouts.id, opts.timeoutId))
	const appEvent = AppEvents.create<AppEvents.TimeoutCancelled>({
		type: 'TIMEOUT_CANCELLED',
		actor: opts.actor,
		serverId: opts.sliceCtx?.serverId ?? null,
		matchId: opts.sliceCtx ? (await MatchHistory.getCurrentMatch(opts.sliceCtx)).historyEntryId : null,
		causeId: null,
		target: timeout.playerId,
		timeoutId: timeout.id,
	})
	if (opts.sliceCtx) await SquadServer.emitAppEvent(opts.sliceCtx, appEvent)
	else await AppEventsSys.persistAppEvent(ctx, appEvent)
	update$.next()
	return { code: 'ok' }
}

// kicks any of the given (just-connected or roster-swept) players that hold an active timeout,
// attributing the PLAYER_KICKED server event to the timeout's original app event. the kick text is
// re-rendered from the stored template + vars with the REMAINING time substituted for {{duration}}
// (empty when none, so {{#duration}} sections drop out) so the player sees how much longer they're timed out.
export async function enforceTimeouts(ctx: C.Db & C.ServerSlice & CS.AbortSignal, playerIds: SM.PlayerId[]) {
	const active = await getActiveTimeouts(ctx, playerIds)
	for (const timeout of active) {
		const applied = appliedReasonFromRow(timeout)
		const remainingMs = timeout.expiresAt.getTime() - Date.now()
		const message = applied
			? AAR.renderAppliedReason(applied, { extraVars: { duration: remainingMs > 0 ? formatDurationApprox(remainingMs) : '' } })
			: DEFAULT_TIMEOUT_TEXT
		await SquadServer.kickPlayerAction(
			ctx,
			timeout.playerId,
			timeout.appEventId ? { type: 'event', id: timeout.appEventId } : { type: 'system' },
			message,
		)
	}
}

export const router = {
	listActiveTimeouts: orpcBase.handler(async ({ context: ctx }) => {
		return await listActiveTimeouts(ctx)
	}),

	watchActiveTimeouts: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ signal, context: ctx }) {
		yield await listActiveTimeouts(ctx)
		for await (const _ of toAsyncGenerator(update$.pipe(withAbortSignal(signal!)))) {
			yield await listActiveTimeouts(ctx)
		}
	}),

	cancelTimeout: orpcBase
		.input(z.object({ timeoutId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyAnyTimeoutGrant(ctx)
			if (denyRes) return denyRes
			return await cancelTimeout(ctx, { timeoutId: input.timeoutId, actor: { type: 'slm-user', userId: ctx.user.discordId } })
		}),

	timeoutPlayer: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				playerId: SM.PlayerIdSchema,
				durationMs: z.number().int().positive(),
				reason: z.string().trim().min(1).optional(),
				presetReasonLabel: z.string().min(1).optional(),
			}).refine(i => !(i.reason && i.presetReasonLabel), { error: 'At most one of reason or presetReasonLabel may be provided' }),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = SquadServer.trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyTimeoutForUser(ctx, input.durationMs)
			if (denyRes) return denyRes
			const reasonRes = SquadServer.resolveReasonInput('timeout', input, { duration: formatHumanTime(input.durationMs) })
			if (reasonRes.code !== 'ok') return reasonRes
			const teamsRes = await ctx.server.teams.get(ctx)
			if (teamsRes.code !== 'ok') return teamsRes
			const target = SM.PlayerIds.find(teamsRes.players, p => p.ids, input.playerId)
			if (!target) return { code: 'err:player-not-found' as const, msg: 'Player is not on the server' }
			return await kickWithTimeout(ctx, {
				target,
				durationMs: input.durationMs,
				actor: { type: 'slm-user', userId: ctx.user.discordId },
				reason: reasonRes.applied,
			})
		}),
}
