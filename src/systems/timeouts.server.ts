import * as E from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import { createId } from '@/lib/id'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Rx from '@/lib/rxjs'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as SM_Msgs from '@/messages/squad.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared.models'
import type * as MH from '@/models/match-history.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'

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
	// the in-game admin who issued it, for an 'ingame-user' actor: this window has no roster to resolve one against
	actorUsername: string | null
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
	// the players table is joined twice: once for the player under timeout, once for the admin who issued it
	const actorPlayer = alias(Schema.players, 'actorPlayer')
	const rows = await ctx
		.db()
		.select({
			timeout: Schema.timeouts,
			username: Schema.players.username,
			steamId: Schema.players.steamId,
			actorType: Schema.appEvents.actorType,
			actorUserId: Schema.appEvents.actorUserId,
			actorPlayerId: Schema.appEvents.actorPlayerId,
			actorUsername: actorPlayer.username,
		})
		.from(Schema.timeouts)
		.leftJoin(Schema.players, E.eq(Schema.timeouts.playerId, Schema.players.eosId))
		.leftJoin(Schema.appEvents, E.eq(Schema.timeouts.appEventId, Schema.appEvents.id))
		.leftJoin(actorPlayer, E.eq(Schema.appEvents.actorPlayerId, actorPlayer.eosId))
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
			actorUsername: row.actorUsername,
			reasonMessage: applied && AAR.renderAppliedReason(applied),
		}
	})
}

// creates the timeout (app event + row) and kicks the player from the issuing server. `reason` carries the
// unrendered template + vars (with the ORIGINAL duration); enforcement re-renders with the remaining one.
export async function kickWithTimeout(
	ctx: C.Db & C.ManagedServer & CS.AbortSignal,
	opts: { target: SM.RecentPlayer; durationMs: number; actor: AppEvents.Actor; reason?: AAR.AppliedReason },
): Promise<{ code: 'ok'; timeoutId: string } | { code: 'err:already-timed-out'; msg: string }> {
	const targetId = SM.PlayerIds.getPlayerId(opts.target.ids)
	// stacking timeouts on one player is almost always a mistake (two admins reacting to the same incident);
	// the existing one must be cancelled before a new one can be issued. checked before the app event is
	// emitted so a rejected kick leaves no audit record.
	const [existing] = await getActiveTimeouts(ctx, [targetId])
	if (existing) {
		const remaining = ZodUtils.formatDurationApprox(existing.expiresAt.getTime() - Date.now())
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
		matchId: currentMatch?.historyEntryId ?? null,
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
	await ctx
		.db()
		.insert(Schema.players)
		.values({
			eosId: targetId,
			steamId: opts.target.ids.steam ? BigInt(opts.target.ids.steam) : undefined,
			username: opts.target.ids.username ?? targetId,
		})
		.onConflictDoNothing({ target: Schema.players.eosId })
	await ctx
		.db()
		.insert(Schema.timeouts)
		.values({
			id: timeoutId,
			playerId: targetId,
			expiresAt,
			appEventId: appEvent.id,
			issuedServerId: ctx.serverId,
			reasonLabel: opts.reason?.label ?? null,
			reasonTemplate: opts.reason?.template ?? null,
			reasonVars: opts.reason?.vars ?? null,
		})
	// ahead of the kick and the admin notice, so watchers list the timeout without waiting on rcon
	update$.next()
	const message = ctx.tr.text(SM_Msgs.notifyKicked(opts.reason && AAR.renderAppliedReason(opts.reason)))
	await SquadServer.kickPlayerAction(ctx, targetId, { type: 'event', id: appEvent.id }, message)
	await SquadServer.notifyAdminsOfWebAction(ctx, appEvent)
	return { code: 'ok', timeoutId }
}

// sets the cancelled flag and records the cancellation. serverCtx (when the cancellation originates in-game)
// routes the app event into that server's activity feed; otherwise it is audit-only.
export async function cancelTimeout(
	ctx: C.Db,
	opts: { timeoutId: string; actor: AppEvents.Actor; serverCtx?: C.Db & SQS.Ctx & MH.Ctx & CS.AbortSignal },
): Promise<{ code: 'ok' } | { code: 'err:not-found'; msg: string }> {
	const [timeout] = await ctx
		.db()
		.select()
		.from(Schema.timeouts)
		.where(E.and(E.eq(Schema.timeouts.id, opts.timeoutId), activeWhere()))
	if (!timeout) return { code: 'err:not-found', msg: 'No active timeout found' }
	await ctx.db().update(Schema.timeouts).set({ cancelled: true }).where(E.eq(Schema.timeouts.id, opts.timeoutId))
	update$.next()
	const appEvent = AppEvents.create<AppEvents.TimeoutCancelled>({
		type: 'TIMEOUT_CANCELLED',
		actor: opts.actor,
		serverId: opts.serverCtx?.serverId ?? null,
		matchId: opts.serverCtx ? ((await MatchHistory.getCurrentMatch(opts.serverCtx))?.historyEntryId ?? null) : null,
		causeId: null,
		target: timeout.playerId,
		timeoutId: timeout.id,
	})
	if (opts.serverCtx) await SquadServer.emitAppEvent(opts.serverCtx, appEvent)
	else await AppEventsSys.persistAppEvent(ctx, appEvent)
	return { code: 'ok' }
}

// kicks any of the given (just-connected or roster-swept) players that hold an active timeout,
// attributing the PLAYER_KICKED server event to the timeout's original app event. the kick text is
// re-rendered from the stored template + vars with the REMAINING time substituted for {{duration}}
// (empty when none, so {{#duration}} sections drop out) so the player sees how much longer they're timed out.
export async function enforceTimeouts(ctx: C.Db & C.ManagedServer & CS.AbortSignal, playerIds: SM.PlayerId[]) {
	const active = await getActiveTimeouts(ctx, playerIds)
	for (const timeout of active) {
		const applied = appliedReasonFromRow(timeout)
		const remainingMs = timeout.expiresAt.getTime() - Date.now()
		const rendered =
			applied &&
			AAR.renderAppliedReason(applied, { extraVars: { duration: remainingMs > 0 ? ZodUtils.formatDurationApprox(remainingMs) : '' } })
		const message = ctx.tr.text(SM_Msgs.notifyKicked(rendered ?? undefined))
		await SquadServer.kickPlayerAction(
			ctx,
			timeout.playerId,
			timeout.appEventId ? { type: 'event', id: timeout.appEventId } : { type: 'system' },
			message,
		)
	}
}

// The join is the same for every watcher, and a permission change re-runs every affected watcher at once, so it is read
// once per change to the timeouts and filtered per caller. Subscribed at module load, ahead of any watcher, so the
// cache is dropped before a watcher reacts to the same change.
let activeTimeouts: Promise<ActiveTimeoutRow[]> | null = null
update$.subscribe(() => (activeTimeouts = null))
function cachedActiveTimeouts(ctx: C.Db): Promise<ActiveTimeoutRow[]> {
	if (activeTimeouts) return activeTimeouts
	const read = listActiveTimeouts(ctx).catch((err: unknown) => {
		if (activeTimeouts === read) activeTimeouts = null
		throw err
	})
	activeTimeouts = read
	return read
}

// A timeout names the player, the admin who issued it and why, so it is shown only to those who can see the server that
// issued it. One whose server is gone is shown to anyone who can see any server.
async function listVisibleActiveTimeouts(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal): Promise<ActiveTimeoutRow[]> {
	const [rows, canAccess] = await Promise.all([cachedActiveTimeouts(ctx), Rbac.getUserAccessCheck(ctx)])
	const now = Date.now()
	return rows.filter(
		(row) =>
			row.expiresAt.getTime() > now &&
			canAccess(row.issuedServerId === null ? RBAC.Req.viewAnyServer() : RBAC.Req.viewServer(row.issuedServerId)),
	)
}

export const router = {
	listActiveTimeouts: orpcBase.handler(async ({ context: ctx }) => {
		return await listVisibleActiveTimeouts(ctx)
	}),

	watchActiveTimeouts: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal, context: ctx }) {
		yield await listVisibleActiveTimeouts(ctx)
		const changed$ = Rx.merge(update$, Rbac.userInvalidation$(ctx.user.discordId))
		for await (const _ of Rx.Ext.toAsyncGenerator(changed$.pipe(Rx.Ext.withAbortSignal(signal!)))) {
			yield await listVisibleActiveTimeouts(ctx)
		}
	}),

	cancelTimeout: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ timeoutId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			// which server's grant applies is a property of the timeout, so the row is read before the check rather
			// than taken from the request
			const [timeout] = await ctx
				.db()
				.select({ issuedServerId: Schema.timeouts.issuedServerId })
				.from(Schema.timeouts)
				.where(E.and(E.eq(Schema.timeouts.id, input.timeoutId), activeWhere()))
			if (!timeout) return { code: 'err:not-found' as const, msg: 'No active timeout found' }
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, SM.Grants.anyTimeout(timeout.issuedServerId))
			if (denyRes) return denyRes
			return await cancelTimeout(ctx, { timeoutId: input.timeoutId, actor: { type: 'slm-user', userId: ctx.user.discordId } })
		}),

	timeoutPlayer: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z
				.object({
					serverId: z.string(),
					playerId: SM.PlayerIdSchema,
					durationMs: z.number().int().positive(),
					reason: z.string().trim().min(1).optional(),
					presetReasonLabel: z.string().min(1).optional(),
					// set when the target is being timed out as part of a whole squad; exposed to reason templates as {{squadName}}
					squadName: z.string().min(1).optional(),
				})
				.refine((i) => !(i.reason && i.presetReasonLabel), { error: 'At most one of reason or presetReasonLabel may be provided' }),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const reasonRes = SquadServer.resolveReasonInput('timeout', input, {
				duration: ZodUtils.formatHumanTime(input.durationMs),
				...(input.squadName ? { squadName: input.squadName } : {}),
			})
			if (reasonRes.code !== 'ok') return reasonRes
			const teamsRes = await ctx.squadRcon.teams.get(ctx)
			if (teamsRes.code !== 'ok') return teamsRes
			const target =
				SM.PlayerIds.find(teamsRes.players, (p) => p.ids, input.playerId) ??
				CHAT.InterpolableState.findRecentPlayer(ctx.server.chatInterpolatedState, { eos: input.playerId })
			if (!target) return { code: 'err:player-not-found' as const, msg: 'Player has not been on the server this match' }
			return await kickWithTimeout(ctx, {
				target,
				durationMs: input.durationMs,
				actor: { type: 'slm-user', userId: ctx.user.discordId },
				reason: reasonRes.applied,
			})
		}),
}
