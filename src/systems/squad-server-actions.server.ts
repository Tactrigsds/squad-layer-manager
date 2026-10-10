// Admin actions against a managed server (kicks, warns, squad and team changes, broadcasts, ending a match).
// Each records an app event, and an action that causes a server event arms the attribution that links the two.

import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import * as Templating from '@/lib/templating'
import { assertNever } from '@/lib/type-guards'
import * as AAR_Msgs from '@/messages/admin-action-reasons.messages'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared.models'
import * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as PendingEvents from '@/models/pending-events.models'
import type * as SETTINGS from '@/models/settings.models'
import type * as SR from '@/models/squad-rcon.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import type * as C from '@/server/context.ts'
import * as AdminList from '@/systems/adminlist.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServerIngest from '@/systems/squad-server-ingest.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'

// persists an SLM app (audit) event and streams it into this server's activity feed. Persist happens before
// the push (and before any server event that links to it via appEventId is later saved), satisfying the FK.
export async function emitAppEvent(ctx: SQS.Ctx & C.Db & CS.AbortSignal, appEvent: AppEvents.AppEvent) {
	await AppEventsSys.persistAppEvent(ctx, appEvent)
	ctx.server.emittedAppEvents.push(appEvent)
	ctx.server.appEvent$.emit(appEvent)
}

// resolves a preset admin-action reason against the current global settings. handlers call this before executing
// anything so a stale preset (deleted/retargeted since the client loaded it) fails the whole action.
export function resolvePresetReason(action: AAR.AdminActionType, presetReasonLabel: string) {
	return AAR.resolveReasonByLabel(Settings.GLOBAL_SETTINGS.adminActionReasons, action, presetReasonLabel)
}

// the variable context for reason/broadcast message templates: the admin-configured custom variables, expanded
// against each other, overlaid with any per-call standard variables (e.g. duration). squadName is a standard
// variable too: the target squad's name when the action targets a whole squad, empty otherwise, so
// {{#squadName}} sections drop out for player targets.
export function messageVars(extra?: Record<string, string>): Record<string, string> {
	return Templating.resolveTemplateVars(Settings.GLOBAL_SETTINGS.messageVariables, { squadName: '', ...extra })
}

// enforces the per-action "require a reason" setting; returns an error result when the action needs a reason
// and none was provided, else null. A warn is nothing but its reason, so one is always required (which is why
// warn isn't configurable in requireReasonFor).
export function reasonRequirementError(
	action: AAR.AdminActionType,
	hasReason: boolean,
): { code: 'err:reason-required'; msg: string } | null {
	if (hasReason) return null
	const required = action === 'warn' || Settings.GLOBAL_SETTINGS.requireReasonFor.some((a) => a === action)
	if (required) return { code: 'err:reason-required', msg: `A reason is required for ${AAR_Msgs.actionNames[action].original}.` }
	return null
}

// resolves a web action's reason input into an AppliedReason snapshot: enforces the require-reason setting,
// resolves preset labels against current settings (a stale preset fails the whole action), and snapshots the
// message variables so custom and preset text render identically everywhere. `applied` is undefined only when
// no reason was given and the action doesn't require one.
export function resolveReasonInput(
	action: AAR.AdminActionType,
	input: { reason?: string; presetReasonLabel?: string },
	extraVars?: Record<string, string>,
):
	| { code: 'ok'; applied?: AAR.AppliedReason }
	| { code: 'err:reason-required'; msg: string }
	| Exclude<AAR.ResolveReasonRes, { code: 'ok' }> {
	const rr = reasonRequirementError(action, !!(input.reason || input.presetReasonLabel))
	if (rr) return rr
	if (input.presetReasonLabel) {
		const res = resolvePresetReason(action, input.presetReasonLabel)
		if (res.code !== 'ok') return res
		return { code: 'ok', applied: AAR.applyReason(action, res.reason, messageVars(extraVars)) }
	}
	if (input.reason) return { code: 'ok', applied: AAR.applyCustomReason(input.reason, messageVars(extraVars)) }
	return { code: 'ok' }
}

// warns every in-game admin of a web-initiated admin action so they see activity they'd otherwise only find in
// the web feed. In-game commands already echo to the invoking admin via reply() (and warn the target), so this
// fires only for slm-user (web) actors; ingame-user/system actions no-op.
export async function notifyAdminsOfWebAction(
	ctx: SR.Ctx & C.Db & CS.AbortSignal & Msgs.Ctx,
	appEvent: AppEvents.AppEvent,
	// override the default describeAppEvent phrasing (e.g. squad warns name the squad + faction)
	description?: string,
) {
	if (appEvent.actor.type !== 'slm-user') return
	const name = await Users.resolveDisplayName(ctx, appEvent.actor.userId)
	await SquadRcon.warnAllAdmins(ctx, `${name} ${description ?? AppEvents_Msgs.describeAppEvent(appEvent)}`)
}

// delivers a preset reason's message to the affected players as an in-game warn, attributing the landing
// PLAYER_WARNED server events to the originating action's app event (so they collapse under it in the feed
// rather than emitting a separate PLAYER_WARNED app event).
async function sendReasonFollowUpWarn(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & CS.AbortSignal & Msgs.Ctx,
	appEventId: AppEvents.AppEventId,
	targets: SM.PlayerId[],
	message: string,
) {
	if (targets.length === 0) return
	const source = { type: 'event' as const, id: appEventId }
	await SquadServerIngest.collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.expectWarn(ctx.server.eventState, { playerId: target, reason: message, source })
		}
	})
	await SquadRcon.warnAll(ctx, targets, message)
}

// kicks a single player, attributing the resulting PLAYER_KICKED server event to `source` (the app event that
// caused it: PLAYER_TIMED_OUT for timeout kicks and their later enforcement, PLAYER_KICKED for plain kicks).
// The primitive both kick paths bottom out in; it emits no app event of its own.
export async function kickPlayerAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & CS.AbortSignal,
	target: SM.PlayerId,
	source: PendingEvents.ArmedActionSource,
	reason?: string,
) {
	await SquadServerIngest.collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_KICKED', playerId: target }, source)
	})
	await SquadRcon.kickPlayer(ctx, target, reason)
}

// a plain kick (no timeout): the players are removed and may rejoin immediately. One app event covers the players
// the roster confirms gone, and each kick's server event is attributed to it. Returns those players.
export async function kickPlayersAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
): Promise<SM.PlayerId[]> {
	if (targets.length === 0) return []
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const message = ctx.tr.text(SM_Msgs.notifyKicked(reason && AAR.renderAppliedReason(reason)))
	let appEvent: AppEvents.PlayerKicked
	{
		// The app event can only be written once the roster confirms the kicks, and a kick's server event references it.
		// Holding the processing lock keeps those server events buffered until the app event exists.
		using _lock = await Prom.acquireInBlock(ctx.server.processEventsMtx, { signal: ctx.signal })
		const kicked = await SquadRcon.kickPlayersConfirmed(ctx, targets, message)
		if (kicked.length === 0) return []
		appEvent = AppEvents.create<AppEvents.PlayerKicked>({
			type: 'PLAYER_KICKED',
			actor,
			serverId: ctx.serverId,
			matchId: currentMatch?.historyEntryId ?? null,
			causeId: null,
			targets: kicked,
			reason,
		})
		await emitAppEvent(ctx, appEvent)
		for (const target of kicked) {
			PendingEvents.armExpectation(
				ctx.server.eventState,
				{ type: 'PLAYER_KICKED', playerId: target },
				{ type: 'event', id: appEvent.id },
			)
		}
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
	return appEvent.targets
}

export async function broadcastAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	message: string,
	actor: AppEvents.Actor,
	opts?: { presetLabel?: string },
) {
	// render {{var}} templating; the rendered text is what's broadcast and what the audit records
	const rendered = Templating.renderTemplate(message, messageVars({ label: opts?.presetLabel ?? '' }))
	const appEvent = AppEvents.create<AppEvents.BroadcastSent>({
		type: 'BROADCAST_SENT',
		actor,
		serverId: ctx.serverId,
		// feed-visible: the landing ADMIN_BROADCAST server event is attributed to this and collapses under it, which
		// is what makes the broadcast read as the admin who sent it rather than as an anonymous RCON line
		matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
		causeId: null,
		message: rendered,
		presetLabel: opts?.presetLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await SquadServerIngest.collectEvents(ctx, () => {
		// a long broadcast reaches the game as several rcon calls, and the game logs each one
		for (const message of SquadRcon.splitBroadcast(rendered)) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'ADMIN_BROADCAST', message }, source)
		}
	})
	await SquadRcon.broadcast(ctx, rendered)
}

/**
 * Ends the current match and waits for the round end it produces.
 *
 * The app event is recorded and the expectation armed before the rcon command goes out, so the ROUND_ENDED
 * that lands is attributed to `actor` rather than reported as an anonymous RCON tool's doing: the game log
 * cannot tell the two apart.
 */
export async function endMatchAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal,
	actor: AppEvents.Actor,
): Promise<{ code: 'ok' | 'err:timeout' | 'err:unknown'; message: string }> {
	const matchEnded$ = ctx.server.event$.pipe(
		Rx.map(([_, e]) => e),
		Rx.filter((e) => e.type === 'ROUND_ENDED'),
		Rx.endWith(null),
	)
	const result$ = Rx.Ext.firstValueFrom(Rx.race(matchEnded$, Rx.timer(20_000).pipe(Rx.map(() => 'timeout' as const))), ctx.signal)

	const matchEnded = AppEvents.create<AppEvents.MatchEnded>({
		type: 'MATCH_ENDED',
		actor,
		serverId: ctx.serverId,
		matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
		causeId: null,
	})
	await emitAppEvent(ctx, matchEnded)
	await SquadServerIngest.collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'ROUND_ENDED' }, { type: 'event', id: matchEnded.id })
	})
	await SquadRcon.endMatch(ctx)

	const result = await result$
	if (result === 'timeout') return { code: 'err:timeout' as const, message: 'Failed to end match: operation timed out' }
	if (result === null) return { code: 'err:unknown' as const, message: 'Failed to end match: unknown error' }
	if (result.type === 'ROUND_ENDED') return { code: 'ok' as const, message: 'Match ended successfully' }
	assertNever(result.type)
}

// warns players through an app event: creates the PLAYER_WARNED app event (so the feed can aggregate the
// resulting warns under one entry), arms the pending-events machine to attribute each landing PLAYER_WARNED server
// event to it, then issues the warns. Emit (persist) precedes arming and the warns so the app event exists before
// any server event referencing it is saved.
export async function warnPlayers(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	reason: string,
	actor: AppEvents.Actor,
	// notifyAdmins: forces the meta-notification on or off; left undefined it follows the admin-target rule below.
	// adminNotifyDescription: override the admin-notification phrasing (squad warns name the squad + faction)
	// adminNotifyMessage: the text the notification quotes, when that should differ from what was delivered (the
	// notification already names the actor, so it drops the delivered message's sender prefix)
	opts?: { reasonLabel?: string; notifyAdmins?: boolean; adminNotifyDescription?: string; adminNotifyMessage?: string },
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerWarned>({
		type: 'PLAYER_WARNED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		message: reason,
		targets,
		reasonLabel: opts?.reasonLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await SquadServerIngest.collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.expectWarn(ctx.server.eventState, { playerId: target, reason, source })
		}
	})
	await SquadRcon.warnAll(ctx, targets, reason)
	// in-game commands echo to the invoking admin themselves, so there's nothing to classify or notify for them
	if (opts?.notifyAdmins === false || actor.type !== 'slm-user') return
	const audience = await classifyWarnTargets(ctx, targets)
	if (opts?.notifyAdmins === undefined) {
		// admin-to-admin chatter shouldn't page the whole admin team; a preset reason is a formal action, so it still does
		if (!opts?.reasonLabel && audience.allAdmins) return
	}
	const notifyMessage = opts?.adminNotifyMessage ?? reason
	await notifyAdminsOfWebAction(ctx, appEvent, opts?.adminNotifyDescription ?? `warned ${audience.label}: ${notifyMessage}`)
}

// resolves warn targets against the live roster: the matching players (undefined where a target isn't online) plus
// whether they're all admins and whether they're the entire online admin roster
async function resolveWarnTargets(ctx: SR.Ctx & CS.AbortSignal, targets: SM.PlayerId[]) {
	const [adminLists, teamsRes] = await Promise.all([AdminList.getListsForServerId(ctx, ctx.serverId), ctx.squadRcon.teams.get(ctx)])
	if (teamsRes.code !== 'ok') return { players: [], allAdmins: false, isEntireAdminRoster: false }

	const isAdmin = (player: SM.Player) => SM.AdminList.isAdminInAny(adminLists, player.ids as SM.PlayerIds.IdQuery<'steam' | 'eos'>)
	const players = targets.map((target) => SM.PlayerIds.find(teamsRes.players, (p) => p.ids, target))
	const allAdmins = players.every((player) => !!player && isAdmin(player))
	return { players, allAdmins, isEntireAdminRoster: allAdmins && players.length === teamsRes.players.filter(isAdmin).length }
}

// the "@..." tag prepended to a warn so recipients see who it's aimed at: an explicit squad warn keeps its squad
// tag, a lone target is named, the whole online admin roster reads as "@admins", and any other set goes untagged.
export async function resolveWarnAudienceTag(
	ctx: SR.Ctx & CS.AbortSignal,
	targets: SM.PlayerId[],
	taggedSquad?: { squadId: number; squadName: string; teamId: SM.TeamId },
) {
	if (taggedSquad) return SM.squadWarnTag(taggedSquad)
	const resolved = await resolveWarnTargets(ctx, targets)
	if (targets.length === 1) {
		const username = resolved.players[0]?.ids.username
		return username ? `@${username}` : undefined
	}
	return resolved.isEntireAdminRoster ? '@admins' : undefined
}

// who a warn hit, phrased for the admin notification: the warnee by name for a single target, "all admins" when it
// reached exactly the online admin roster, otherwise a plain count. allAdmins also drives the notification opt-out.
async function classifyWarnTargets(ctx: SR.Ctx & CS.AbortSignal, targets: SM.PlayerId[]) {
	const count = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`
	const resolved = await resolveWarnTargets(ctx, targets)
	if (resolved.isEntireAdminRoster) return { allAdmins: resolved.allAdmins, label: 'all admins' }
	const only = resolved.players.length === 1 ? resolved.players[0]?.ids.username : undefined
	return { allAdmins: resolved.allAdmins, label: only ?? count(targets.length) }
}

// disbands a squad through an app event: records the squad + its members, arms the machine to attribute the
// resulting SQUAD_DISBANDED server event to the acting user, then issues the disband.
export async function disbandSquadAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	teamId: SM.TeamId,
	squadId: SM.SquadId,
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const teams = SquadServer.getCurrTeams(ctx)
	const squad = teams && SM.findSquadForPlayer(teams.squads, { squadId, teamId })
	const members: SM.PlayerId[] = []
	for (const [id, player] of teams?.players ?? []) {
		if (player.teamId === teamId && player.squadId === squadId) members.push(id)
	}
	const appEvent = AppEvents.create<AppEvents.SquadDisbanded>({
		type: 'SQUAD_DISBANDED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		teamId,
		squadId,
		squadName: squad?.squadName ?? `Squad ${squadId}`,
		members,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await SquadServerIngest.collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'SQUAD_DISBANDED', teamId, squadId }, source)
	})
	await SquadRcon.disbandSquad(ctx, teamId, squadId)
	if (reason) {
		await sendReasonFollowUpWarn(
			ctx,
			appEvent.id,
			members,
			AAR.renderAppliedReason(reason, { audienceTag: squad ? SM.squadWarnTag(squad) : `@Squad${squadId}` }),
		)
	}
	// name the squad + faction consistently with squad warns (e.g. "disbanded Squad1 (PLA)")
	const squadLabel = squad ? SM.squadAdminLabel(squad, currentMatch && MH.getTeamFaction(currentMatch, teamId)) : `Squad${squadId}`
	await notifyAdminsOfWebAction(ctx, appEvent, `disbanded ${squadLabel}${reason?.label ? ` for ${reason.label}` : ''}`)
}

// removes players from their squads through an app event, attributing each resulting PLAYER_LEFT_SQUAD server event
export async function removePlayersFromSquad(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerRemovedFromSquad>({
		type: 'PLAYER_REMOVED_FROM_SQUAD',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		targets,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await SquadServerIngest.collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_LEFT_SQUAD', playerId: target }, source)
		}
	})
	await Promise.all(targets.map((target) => SquadRcon.removeFromSquad(ctx, target)))
	if (reason) {
		await sendReasonFollowUpWarn(ctx, appEvent.id, targets, AAR.renderAppliedReason(reason))
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}

// records a forced team change as an app event and arms attribution for the resulting PLAYER_CHANGED_TEAM server
// events (which arrive via the next teams poll). The caller (teamswaps) still issues the actual switch. Returns the
// event so a re-fire of the same switch can attribute to it rather than logging itself a second time.
export async function forceTeamChangeAppEvent(
	ctx: SQS.Ctx & C.Db & MH.Ctx & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.TeamChangeForced>({
		type: 'TEAM_CHANGE_FORCED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		targets,
	})
	await emitAppEvent(ctx, appEvent)
	await armTeamChangeAttribution(ctx, targets, appEvent.id)
	return appEvent
}

// arms attribution for the PLAYER_CHANGED_TEAM events a forced switch produces, against an app event that already
// records that switch. A queue execution logs itself as a TEAMSWAPS_UPDATED, so a TEAM_CHANGE_FORCED alongside it
// would say the same thing twice.
export async function armTeamChangeAttribution(
	ctx: SQS.Ctx & C.Db & CS.AbortSignal,
	targets: SM.PlayerId[],
	causeId: AppEvents.AppEventId,
) {
	if (targets.length === 0) return
	const source = { type: 'event' as const, id: causeId }
	await SquadServerIngest.collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_CHANGED_TEAM', playerId: target }, source)
		}
	})
}

// records a kill as an app event and arms attribution for any resulting PLAYER_CHANGED_TEAM server events. The
// double switch nets zero, so a settled teams poll usually emits none; arming keeps parity with the forced-switch
// path in case a poll observes an intermediate state.
export async function killPlayersAppEvent(
	ctx: SQS.Ctx & C.Db & MH.Ctx & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: string,
	reasonLabel?: string,
): Promise<AppEvents.PlayerKilled | undefined> {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerKilled>({
		type: 'PLAYER_KILLED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		targets,
		reason,
		reasonLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await SquadServerIngest.collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_CHANGED_TEAM', playerId: target }, source)
		}
	})
	return appEvent
}

export async function killPlayersAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: string,
	reasonLabel?: string,
) {
	if (targets.length === 0) return
	const appEvent = await killPlayersAppEvent(ctx, targets, actor, reason, reasonLabel)
	await SquadRcon.killPlayers(ctx, targets, reason)
	if (appEvent) await notifyAdminsOfWebAction(ctx, appEvent)
}

export async function renameSquadAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal,
	teamId: SM.TeamId,
	squadId: SM.SquadId,
	actor: AppEvents.Actor,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const renameTeams = SquadServer.getCurrTeams(ctx)
	const squad = renameTeams && SM.findSquadForPlayer(renameTeams.squads, { squadId, teamId })
	const appEvent = AppEvents.create<AppEvents.SquadRenamed>({
		type: 'SQUAD_RENAMED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		teamId,
		squadId,
		squadName: squad?.squadName ?? `Squad ${squadId}`,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await SquadServerIngest.collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'SQUAD_RENAMED', teamId, squadId }, source)
	})
	await SquadRcon.adminRenameSquad(ctx, teamId, squadId)
}

// demoting a commander has no attributable server event, so this is a pure audit-feed entry
export async function demoteCommanderAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	playerId: SM.PlayerId,
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.CommanderDemoted>({
		type: 'COMMANDER_DEMOTED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		target: playerId,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	await SquadRcon.demoteCommander(ctx, playerId)
	if (reason) {
		await sendReasonFollowUpWarn(ctx, appEvent.id, [playerId], AAR.renderAppliedReason(reason))
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}
