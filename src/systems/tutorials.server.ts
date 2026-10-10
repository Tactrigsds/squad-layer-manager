import { Mutex } from 'async-mutex'
import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema.ts'
import * as Verbs from '@/emulator/verbs'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as CMD from '@/models/command.models'
import type * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as LQ from '@/models/layer-queue.models'
import type * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list'
import type * as SR from '@/models/squad-rcon.models'
import type * as SQS from '@/models/squad-server.models'
import * as TUT from '@/models/tutorial.models'
import type * as V from '@/models/vote.models'
import type * as C from '@/server/context'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Sandbox from '@/systems/sandbox.server'
import * as Settings from '@/systems/settings.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as SwitchRequests from '@/systems/switch-requests.server'
import * as Teamswaps from '@/systems/teamswaps.server'
import * as Timeouts from '@/systems/timeouts.server'
import * as UserPresence from '@/systems/user-presence.server'
import * as WsSessionSys from '@/systems/ws-session.server'

// The tutorial runtime. A run is one scoped, ephemeral emulated server (src/emulator, via sandbox.server) staged
// for a scenario, with a coachmark tour narrating the real dashboard on top of it. This file is the server half:
// the run registry, the lifecycle that stands a server up and tears it down, the staging helpers a scenario drives
// it with, and the oRPC surface the client talks to. The client half is the tour engine (Phase 5); the model
// (schemas, importable from the client) is src/models/tutorial.models.ts.

const module = initModule('tutorials')
const orpcBase = getOrpcBase(module)
let log!: CS.Logger

// what a stage runs against: the managed server's usual surface plus the sandbox instance it drives and the run's
// owner. Wide enough to feed LayerQueueSys.dispatchOp (its SideEffectCtx); resolveCtx supplies the whole managed
// server at runtime. A helper needing less narrows, per the minimum-ctx rule.
export type StageCtx = C.Db &
	C.ManagedServer &
	SQS.Ctx &
	LQ.Ctx &
	MH.Ctx &
	V.Ctx &
	SR.Ctx.Rcon &
	SETTINGS.Ctx &
	Msgs.Ctx &
	CS.AbortSignal & { sandbox: Sandbox.SandboxInstance; owner: bigint }

// How far into their local day the reader is. A duration rather than a timestamp, so it survives clock skew between
// the reader and the server.
type ReaderClock = { msIntoDay: number }

type ScenarioDef<S extends string> = {
	id: TUT.ScenarioId
	// instance policy: every scenario states its own pacing, because the emulator's defaults are tuned for realism,
	// not narration (a ~30s post-match wait and constant tick chatter)
	pacing: { postMatchDelayMs: number; tickChatter: boolean }
	// how many players larger a /switch sender's team must be to move at once; the server default when absent
	instantSwapLead?: number
	// the saved queue the server boots with. Seeded declaratively through createServerEntry rather than dispatched
	// after enable: at creation there is no client, no vote and no sync to reproduce the production way.
	initialQueue: (owner: bigint) => LL.List
	// runs once inside start(), after enable and before the client sees the server
	setup: (ctx: StageCtx, reader: ReaderClock) => Promise<void>
	// idempotent, individually addressable staging blocks. Each asserts the state it needs and creates whatever is
	// missing, so any step can be re-entered.
	stages: Record<S, (ctx: StageCtx) => Promise<TUT.StageResult>>
}

// identity helper: the point is inferring S from the stages record, so a steps file (Phase 5) naming a stage the
// server half lacks is a compile error
function defScenario<S extends string>(d: ScenarioDef<S>): ScenarioDef<S> {
	return d
}

// ============================== staging helpers ==============================

type SyncCtx = LQ.Ctx & CS.AbortSignal & { sandbox: Sandbox.SandboxInstance }

// whether the emulated server is actually holding the queue's head as its next layer. The ground truth is the
// emulator's own nextLayer (as the harness checks), not nextLayerSyncState$: that subject initializes optimistically
// to 'synced', so a freshly booted server would report synced before its first real sync has set anything.
function serverHoldsQueueHead(ctx: SyncCtx): boolean {
	const headLayerId = LL.getNextLayerId(ctx.layerQueue.session.state.savedList)
	if (!headLayerId) return true
	return ctx.sandbox.emu.world.nextLayer?.layer === L.getLayerCommand(headLayerId, 'none').split(' ')[0]
}

// hold until the emulated server holds the saved queue's head as its next layer. Every path that later ends a match
// waits on this first, so a roll lands on the intended layer rather than the emulator's default seed. Driven by the
// sync-state subject as the push signal, but gated on the emulator ground truth so the optimistic initial 'synced'
// cannot slip a stale pass through.
export async function waitForNextLayerSynced(ctx: SyncCtx) {
	await Rx.Ext.firstValueFrom(ctx.layerQueue.nextLayerSyncState$.pipe(Rx.filter(() => serverHoldsQueueHead(ctx))), ctx.signal)
}

// hold until a roll started by ending a match has been fully processed: the match row written, the queue head
// shifted, generation landed. serverRolling$ carries the timestamp while that runs and drops back to null once it
// has all committed, so a non-null -> null edge is the settled signal. distinctUntilChanged collapses repeats; the
// BehaviorSubject replays its current null on subscribe, which pairwise then pairs with the roll's timestamp.
export async function waitForRolled(ctx: SQS.Ctx & CS.AbortSignal) {
	await Rx.Ext.firstValueFrom(
		ctx.server.serverRolling$.pipe(
			Rx.distinctUntilChanged(),
			Rx.pairwise(),
			Rx.filter(([prev, curr]) => prev !== null && curr === null),
		),
		ctx.signal,
	)
}

// sync the head as next, end the match decisively, and wait for the roll to finish. The only way a scenario should
// advance a match: ending without the sync-first guard can roll onto the emulator's default seed instead of the head.
export const playMatch = Instr.spanOp('tutorials.playMatch', { module }, async (ctx: StageCtx, opts?: { winnerTeamId?: 1 | 2 }) => {
	await waitForNextLayerSynced(ctx)
	await Verbs.execute(ctx.sandbox, 'end', { winnerTeamId: opts?.winnerTeamId ?? 1 })
	await waitForRolled(ctx)
})

// ============================== checkpoints ==============================

// A checkpoint stage RESETS the run's server state to a named point in the tour, so a jump can land anywhere. All
// state changes go through real queue/presence ops -- never a direct session write, which live clients would not
// see -- and the whole thing is idempotent: a reset to the state the run is already in dispatches nothing heavy.
type ResetSpec = {
	// the saved queue to install, or 'generated': an empty save, which triggers real queue-item generation -- the
	// only way a generated-source item can exist, since the add op stamps every item with its actor as the source
	saved: L.LayerId[] | 'generated'
	// unsaved edits prepended to the draft, as if the reader had just added them
	draftPrepend?: L.LayerId[]
	// fabricate an editing session for the owner's live clients, so the region's editing premise holds on arrival
	readerEditing?: boolean
}

const resetTo = Instr.spanOp('tutorials.resetTo', { module }, async (ctx: StageCtx, spec: ResetSpec): Promise<TUT.StageResult> => {
	const owner = ctx.owner
	// sessions and the peer go first: whatever editors the target region wants are installed at the end, over a
	// clean slate
	await UserPresence.dispatchEndAllLayerQueueEditing(ctx.serverId)
	await UserPresence.dispatchFabricatedDisconnect(peerClientId(ctx.serverId))

	const state = () => ctx.layerQueue.session.state
	// save/reset bump editWindowSeqId, so every op reads it fresh; a stale value silently skips the op
	const opBase = () => ({ opId: SLL.createOpId(), userId: owner, editWindowSeqId: state().editWindowSeqId })

	if (SLL.hasMutations(state())) await LayerQueue.dispatchOp(ctx, { op: 'reset-to-saved', ...opBase() })

	const alreadyThere =
		spec.saved === 'generated'
			? state().savedList.length === 1 && state().savedList[0].source.type === 'generated'
			: state()
					.savedList.map((it) => it.layerId)
					.join() === spec.saved.join()
	if (!alreadyThere) {
		const itemIds = state().list.map((it) => it.itemId)
		if (itemIds.length > 0) await LayerQueue.dispatchOp(ctx, { op: 'clear', itemIds, ...opBase() })
		if (spec.saved !== 'generated') {
			await LayerQueue.dispatchOp(ctx, {
				op: 'add',
				items: spec.saved.map((layerId) => LL.createItem({ type: 'single-list-item', layerId }, { type: 'manual', userId: owner })),
				index: { outerIndex: 0, innerIndex: null },
				...opBase(),
			})
		}
		// saving an empty list requests generation instead of persisting; the client's ready selector waits for
		// the generated head to land
		await LayerQueue.dispatchOp(ctx, { op: 'save', ...opBase() })
	}

	if (spec.draftPrepend?.length) {
		await LayerQueue.dispatchOp(ctx, {
			op: 'add',
			items: spec.draftPrepend.map((layerId) => LL.createItem({ type: 'single-list-item', layerId }, { type: 'manual', userId: owner })),
			index: { outerIndex: 0, innerIndex: null },
			...opBase(),
		})
	}

	if (spec.readerEditing) {
		for (const clientId of ownerClientIds(owner)) await UserPresence.dispatchFabricatedEditor(ctx.serverId, owner, clientId)
	}
	return { code: 'ok' as const }
})

// the owner's live browser clients. Editing is fabricated for all of them, since presence cannot tell which tab is
// on the dashboard; an owner realistically has one.
function ownerClientIds(owner: bigint): string[] {
	return [...WsSessionSys.wsSessions.values()].filter((s) => s.user.discordId === owner).map((s) => s.wsClientId)
}

// ============================== scenarios ==============================

const LAYERS = TUT.LQ_TUTORIAL_LAYERS

const layerQueue = defScenario({
	id: 'layer-queue',
	// a short post-match wait so a staged roll does not stall the tour; no tick chatter so the narrated log stays legible
	pacing: { postMatchDelayMs: 2000, tickChatter: false },
	initialQueue: (owner) =>
		LAYERS.initial.map((layerId) => LL.createItem({ type: 'single-list-item', layerId }, { type: 'manual', userId: owner })),
	setup: async () => {},
	stages: {
		welcome: async (ctx) => {
			await waitForNextLayerSynced(ctx)
			return { code: 'ok' }
		},
		'play-a-match': async (ctx) => {
			await playMatch(ctx)
			return { code: 'ok' }
		},
		// a second editor, so the queue stops saving on its own and force save has something to override
		'second-editor': async (ctx) => {
			await ensurePeerUser(ctx)
			await UserPresence.dispatchFabricatedEditor(ctx.serverId, PEER_USER_ID, peerClientId(ctx.serverId))
			return { code: 'ok' }
		},
		// Checkpoints, one per region of the tour whose server state differs. The canonical lists mirror what a
		// linear reader produces: two picks added at the head, the last seed removed before saving, the head removed
		// again by the force save.
		'cp-fresh': (ctx) => resetTo(ctx, { saved: [...LAYERS.initial] }),
		'cp-edited': (ctx) =>
			resetTo(ctx, {
				saved: [...LAYERS.initial],
				draftPrepend: [LAYERS.picks.chora, LAYERS.picks.yehorivka],
				readerEditing: true,
			}),
		'cp-saved': (ctx) => resetTo(ctx, { saved: [LAYERS.picks.chora, LAYERS.picks.yehorivka, LAYERS.initial[0], LAYERS.initial[1]] }),
		'cp-post-force': (ctx) => resetTo(ctx, { saved: [LAYERS.picks.yehorivka, LAYERS.initial[0], LAYERS.initial[1]] }),
		'cp-generated': (ctx) => resetTo(ctx, { saved: 'generated' }),
	},
})

// ---- player management ----

const ROSTER = TUT.PM_TUTORIAL_ROSTER

// how long a player the roster restore rejoins has to show up on SLM's own roster before the stage gives up
const ROSTER_SETTLE_TIMEOUT_MS = 30_000

// A restored player only counts once the managed server's event pipeline holds them on the team the scenario put
// them on. That roster is what kills, chat and commands are resolved against, and until the pipeline is synced it
// drops every event, so anything a stage makes a player do before then never happens as far as SLM is concerned.
async function waitForRosterSettled(ctx: StageCtx, flipped: boolean) {
	const deadline = Date.now() + ROSTER_SETTLE_TIMEOUT_MS
	while (!ctx.signal.aborted) {
		const eventState = ctx.server.eventState
		const players = [...(eventState.currTeams?.players.values() ?? [])]
		const settled =
			eventState.syncState.type === 'synced' &&
			ROSTER.every((spec) => players.some((p) => p.ids.username === spec.name && p.teamId === rosterTeam(spec, flipped)))
		if (settled) return
		if (Date.now() > deadline) throw new Error('the tutorial roster did not settle on the managed server')
		await ctx.squadRcon.teams.get(ctx, { ttl: 0 })
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
}

// The raw team a roster player is on. PM_TUTORIAL_ROSTER gives the one for the match the reader plays; each roll
// swaps every player's raw team, so during the odd number of rolls the history is played across, it is the other.
function rosterTeam(spec: TUT.PMRosterPlayer, flipped: boolean): 1 | 2 {
	if (!flipped) return spec.team
	return spec.team === 1 ? 2 : 1
}

// Puts every roster player back where the scenario starts them: connected, on their team, in their squad, in their
// admin-list groups. Timeouts go first, since a rejoining player who still holds one is kicked straight back out.
// Idempotent: a player already where they belong is left alone, so a restore of an untouched roster does nothing.
async function restoreRoster(ctx: StageCtx, flipped = false) {
	const world = ctx.sandbox.emu.world
	const rosterIds = ROSTER.map((spec) => world.findPlayer(spec.name)?.eos ?? ctx.sandbox.players.get(spec.name)?.eos).filter(
		(id): id is string => !!id,
	)
	for (const timeout of await Timeouts.getActiveTimeouts(ctx, rosterIds)) {
		await Timeouts.cancelTimeout(ctx, { timeoutId: timeout.id, actor: { type: 'system' } })
	}

	for (const spec of ROSTER) {
		const connected = world.findPlayer(spec.name)
		// a kick takes the player off the world but not out of the sandbox's own name map
		if (!connected) ctx.sandbox.players.delete(spec.name)
		const team = rosterTeam(spec, flipped)
		const player = connected ?? Verbs.joinPlayer(ctx.sandbox, spec.name, team)
		if (player.teamId !== team) world.setTeam(player, team)
		const squadSpec = spec.squad
		if (squadSpec === null) {
			if (player.squadId !== null) world.leaveSquad(player)
		} else {
			const squad = world.squads.find((sq) => sq.teamId === team && sq.name === squadSpec)
			const leads = ROSTER.find((other) => other.squad === squadSpec)?.name === spec.name
			if (!squad) {
				if (leads) world.createSquad(player, squadSpec)
			} else if (player.squadId !== squad.squadId) {
				world.joinSquad(player, squad)
			}
		}
		const groups = ctx.sandbox.list.memberships.get(spec.name)
		if (!groups || groups.size !== spec.groups.length || spec.groups.some((g) => !groups.has(g))) {
			await Verbs.execute(ctx.sandbox, 'set-player-groups', { name: spec.name, groups: spec.groups })
		}
	}
	// a squad member rejoining before their leader has recreated the squad is placed on the second pass
	for (const spec of ROSTER) {
		if (spec.squad === null) continue
		const player = world.findPlayer(spec.name)
		const squad = world.squads.find((sq) => sq.teamId === rosterTeam(spec, flipped) && sq.name === spec.squad)
		if (player && squad && player.squadId !== squad.squadId) world.joinSquad(player, squad)
	}
	await waitForRosterSettled(ctx, flipped)
}

// What happened on the server before the reader arrived, so the activity log, the player details and the K/W/D
// column have something to show. It also sets up the players the tour later acts on: Ruiz teamkills and is warned
// for it before being timed out, and Novak is abusive in chat before being kicked.
type BackstoryBeat =
	| { kill: [victim: string, attacker: string] }
	| { chat: [player: string, channel: 'ChatAll' | 'ChatTeam' | 'ChatSquad' | 'ChatAdmin', message: string] }
	| { rcon: string }
	| { cam: string }

// Written after real chat on a live server, turned up a little. Nothing here looks like a chat command, since the
// sandbox runs the install's real command handling and a line like that would fire one.
const BACKSTORY: BackstoryBeat[] = [
	{ chat: ['Hollis', 'ChatAll', 'gl hf'] },
	{ chat: ['Kestrel', 'ChatSquad', 'rally is up behind the church, spawn on it'] },
	{ chat: ['Okafor', 'ChatSquad', 'BOAT PLZ'] },
	{ kill: ['Hollis', 'Kestrel'] },
	{ kill: ['Petrov', 'Marlow'] },
	{ chat: ['Petrov', 'ChatTeam', 'enemy HAT is like 2m from our hab and nobody cares XD'] },
	{ kill: ['Lindqvist', 'Ruiz'] },
	{ chat: ['Ruiz', 'ChatAll', 'sorry'] },
	{ kill: ['Kestrel', 'Adeyemi'] },
	{ chat: ['Marlow', 'ChatTeam', 'COME PICK ME UP'] },
	{ kill: ['Okafor', 'Ruiz'] },
	{ chat: ['Okafor', 'ChatTeam', 'nice int, ruiz'] },
	{ chat: ['Castellan', 'ChatTeam', 'hey guys i think we need more barbed wire'] },
	{ chat: ['Adeyemi', 'ChatTeam', 'barbed wire wins games'] },
	{ kill: ['Moreau', 'Lindqvist'] },
	{ kill: ['Brightwater', 'Ruiz'] },
	{ chat: ['Brightwater', 'ChatAll', "ruiz just tk'd me at main. AGAIN."] },
	{ chat: ['Ruiz', 'ChatAll', 'sry tk'] },
	{ chat: ['Kestrel', 'ChatAdmin', 'thats the third tk from ruiz this round'] },
	{ rcon: 'AdminWarn "Ruiz" Stop teamkilling. The next one is a timeout.' },
	{ chat: ['Ruiz', 'ChatAll', 'MY BAD, thought he was blufor lmao'] },
	{ kill: ['Okafor', 'Castellan'] },
	{ chat: ['Castellan', 'ChatAll', 'knifed three of your buds in a row. ill do it again'] },
	{ kill: ['Adeyemi', 'Tanaka'] },
	{ chat: ['Novak', 'ChatAll', 'u r all n00bs. cry more'] },
	{ chat: ['Hollis', 'ChatAll', 'lol who is crying'] },
	{ chat: ['Weiss', 'ChatAdmin', 'do we want to deal with novak or let it play out?'] },
	{ cam: 'Weiss' },
	{ kill: ['Quill', 'Kestrel'] },
	{ chat: ['Novak', 'ChatAll', 'THIS SERVER IS TRASH AND SO ARE YOUR ADMINS'] },
	{ rcon: 'AdminBroadcast Identify enemies by uniform or by using your map. Do not rely on nametags!' },
	{ chat: ['Quill', 'ChatTeam', 'someone want to start a squad? we are down a medic'] },
	{ chat: ['Sato', 'ChatAll', 'which way, please?'] },
]

// the log orders events by the time the server wrote them, so each beat gets a moment of its own
const BACKSTORY_BEAT_MS = 100

async function playBeats(ctx: StageCtx, beats: BackstoryBeat[]) {
	const world = ctx.sandbox.emu.world
	const player = (name: string) => world.findPlayer(name)!
	for (const beat of beats) {
		if (ctx.signal.aborted) return
		if ('kill' in beat) {
			const [victim, attacker] = beat.kill
			// a teamkill's wound reads as a second teamkill in the log
			if (player(victim).teamId !== player(attacker).teamId) world.woundPlayer(player(victim), player(attacker))
			world.killPlayer(player(victim), player(attacker))
		} else if ('chat' in beat) {
			const [name, channel, message] = beat.chat
			world.chat(player(name), channel, message)
		} else if ('rcon' in beat) {
			world.handleCommand(beat.rcon)
		} else if ('cam' in beat) {
			world.possessAdminCam(player(beat.cam))
		} else {
			assertNever(beat)
		}
		await new Promise((resolve) => setTimeout(resolve, BACKSTORY_BEAT_MS))
	}
}

// ---- the match history ----

// The two matches played before the reader's, each with a little of the same server's life in it, and which raw
// team won. The raw teams swap between them, so the same raw winner is a different side each time: one side winning
// both is exactly what a balance plugin watches for, and would put its alert over the history. Played for real so their outcome, K/D, layer and who set it are all what SLM recorded, then moved back in
// time (see backdatePastMatches). Two, because a roll swaps every player's raw team and two put them back.
const PAST_MATCHES: { beats: BackstoryBeat[]; winnerTeamId: 1 | 2; startedAgoMin: number; lastedMin: number }[] = [
	{
		winnerTeamId: 2,
		startedAgoMin: 138,
		lastedMin: 64,
		beats: [
			{ chat: ['Weiss', 'ChatAll', 'gl hf, play the objective'] },
			{ kill: ['Kestrel', 'Hollis'] },
			{ kill: ['Marlow', 'Petrov'] },
			{ chat: ['Sato', 'ChatAll', 'donde estan los britons'] },
			{ kill: ['Tanaka', 'Castellan'] },
			{ kill: ['Lindqvist', 'Moreau'] },
			{ chat: ['Okafor', 'ChatTeam', 'HAB ON ME AT UNIVERSITY'] },
			{ kill: ['Adeyemi', 'Kestrel'] },
			{ kill: ['Ruiz', 'Quill'] },
			{ kill: ['Brightwater', 'Hollis'] },
			{ chat: ['Brightwater', 'ChatAll', 'my back ith bwoken'] },
			{ chat: ['Hollis', 'ChatAll', 'good fight'] },
		],
	},
	{
		winnerTeamId: 2,
		startedAgoMin: 68,
		lastedMin: 57,
		beats: [
			{ chat: ['Castellan', 'ChatTeam', 'barbed wire staged down inside bushes on yeho?'] },
			{ kill: ['Hollis', 'Marlow'] },
			{ kill: ['Petrov', 'Kestrel'] },
			{ kill: ['Quill', 'Lindqvist'] },
			{ chat: ['Quill', 'ChatAll', 'with a shovel?'] },
			{ kill: ['Moreau', 'Tanaka'] },
			{ kill: ['Kestrel', 'Castellan'] },
			{ chat: ['Marlow', 'ChatAll', 'NICE TRADE LOL'] },
			{ kill: ['Adeyemi', 'Okafor'] },
			{ chat: ['Kestrel', 'ChatAll', 'good fight'] },
		],
	},
]

// Gives the matches just played a history: each one starts `startedAgoMin` before now and runs `lastedMin`, with
// its events spread across that span in their original order. Its rows are written, then the managed server's
// match history is reloaded and the events cache dropped, so nothing keeps the times it had before.
// The match history panel opens on the reader's today, so a backstory reaching past their midnight is compressed
// to fit inside it. Otherwise a run started shortly after midnight shows no past match to point at.
async function backdatePastMatches(ctx: StageCtx, reader: ReaderClock) {
	const now = Date.now()
	const backstoryMs = Math.max(...PAST_MATCHES.map((plan) => plan.startedAgoMin)) * 60_000
	const scale = Math.min(1, reader.msIntoDay / backstoryMs)
	const past = ctx.matchHistory.recentMatches.filter((match) => !match.isCurrentMatch).slice(-PAST_MATCHES.length)
	for (const [i, match] of past.entries()) {
		const plan = PAST_MATCHES[i]
		// the match the server boots on was already running when SLM connected, so it has no recorded start
		const oldStart = (match.startTime ?? match.createdAt)?.getTime()
		const oldEnd = match.status === 'post-game' && match.endTime !== 'unknown' ? match.endTime.getTime() : undefined
		if (oldStart === undefined || oldEnd === undefined) continue
		const newStart = now - Math.floor(plan.startedAgoMin * 60_000 * scale)
		const newEnd = newStart + Math.floor(plan.lastedMin * 60_000 * scale)
		const oldSpan = Math.max(1, oldEnd - oldStart)
		await ctx
			.db()
			.update(Schema.matchHistory)
			.set({ startTime: new Date(newStart), endTime: new Date(newEnd), createdAt: new Date(newStart) })
			.where(E.eq(Schema.matchHistory.id, match.historyEntryId))
		// the log reads server events and SLM's own (app) events together, so both move. What the roll records
		// after the match ends is pinned to the end, rather than landing after the next match began.
		const rescaled = (column: typeof Schema.serverEvents.time | typeof Schema.appEvents.time) =>
			E.sql`cast(${newStart} + (min(max(${column} - ${oldStart}, 0), ${oldSpan}) * ${newEnd - newStart}) / ${oldSpan} as integer)`
		await ctx
			.db()
			.update(Schema.serverEvents)
			.set({ time: rescaled(Schema.serverEvents.time) })
			.where(E.eq(Schema.serverEvents.matchId, match.historyEntryId))
		await ctx
			.db()
			.update(Schema.appEvents)
			.set({ time: rescaled(Schema.appEvents.time) })
			.where(E.eq(Schema.appEvents.matchId, match.historyEntryId))
		ctx.matchEventsCache.events.delete(match.historyEntryId)
	}
	await MatchHistory.loadState(ctx)
	ctx.matchHistory.dispatchUpdate()
}

async function playMatchHistory(ctx: StageCtx) {
	let flipped = false
	for (const match of PAST_MATCHES) {
		await restoreRoster(ctx, flipped)
		await playBeats(ctx, match.beats)
		await playMatch(ctx, { winnerTeamId: match.winnerTeamId })
		flipped = !flipped
	}
}

// Everything a section of the tour may have changed, undone: nobody kicked, timed out, moved, queued to swap or
// waiting to switch, except `keepRequestFrom`, whose switch request survives so the stage that made it stays idempotent.
async function resetRoster(ctx: StageCtx, keepRequestFrom?: string) {
	// a switch or swap still in flight lands after the restore and undoes it, and holds its player's next request
	const deadline = Date.now() + ROSTER_SETTLE_TIMEOUT_MS
	while (ctx.switchRequests.swapping.size > 0 || ctx.teamswaps.session.state.swapping) {
		if (ctx.signal.aborted) return
		if (Date.now() > deadline) throw new Error('a team change on the tutorial server never finished')
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	UserPresence.dispatchEndAllTeamswapEditing(ctx.serverId)
	const swaps = ctx.teamswaps.session.state
	if (swaps.savedSwaps.size > 0 || swaps.editedSwaps.size > 0) await Teamswaps.dispatchClearSwaps(ctx)
	const kept = keepRequestFrom ? ctx.sandbox.emu.world.findPlayer(keepRequestFrom)?.eos : undefined
	for (const request of [...ctx.switchRequests.state.requests]) {
		if (request.playerId !== kept) await SwitchRequests.cancelSwitch(ctx, request.playerId)
	}
	await restoreRoster(ctx)
}

const playerManagement = defScenario({
	id: 'player-management',
	pacing: { postMatchDelayMs: 2000, tickChatter: false },
	// the switch queue section needs a lone /switch to wait in line. Earlier sections leave the teams up to two apart,
	// and the switch pass can act on a roster that has not caught up with the restore yet
	instantSwapLead: 4,
	// The first two are what the history rolls onto, so the set-by column shows a user on one and SLM on the other;
	// the match the server boots on is the game server's own.
	initialQueue: (owner) => [
		LL.createItem({ type: 'single-list-item', layerId: LAYERS.initial[1] }, { type: 'manual', userId: PEER_USER_ID }),
		LL.createItem({ type: 'single-list-item', layerId: LAYERS.initial[2] }, { type: 'generated' }),
		LL.createItem({ type: 'single-list-item', layerId: LAYERS.initial[0] }, { type: 'manual', userId: owner }),
	],
	setup: async (ctx, reader) => {
		await ensurePeerUser(ctx)
		await playMatchHistory(ctx)
		await restoreRoster(ctx)
		await playBeats(ctx, BACKSTORY)
		// last, because what a roll logs is written a moment after the roll itself settles
		await backdatePastMatches(ctx, reader)
	},
	stages: {
		// Everything a later section of the tour may have changed, undone: nobody kicked, timed out, moved, queued
		// to swap or waiting to switch. One stage for every checkpoint, since each section starts from the same roster.
		'cp-roster': async (ctx) => {
			await resetRoster(ctx)
			return { code: 'ok' }
		},
		// A player asks to switch the way a real one would, by typing the command in chat. Also the checkpoint for
		// the switch queue section, so it resets the roster first: the request only queues while the teams are even.
		'switch-request': async (ctx) => {
			const cmd = Settings.GLOBAL_SETTINGS.commands.requestSwitch
			const trigger = cmd.enabled ? CMD.primaryTrigger(cmd) : undefined
			if (!trigger) return { code: 'err:not-ready', msg: 'The switch command is turned off on this install.' }
			const requester = TUT.PM_TUTORIAL_TARGETS.switchRequest
			await resetRoster(ctx, requester)
			const player = ctx.sandbox.emu.world.findPlayer(requester)
			if (!player) return { code: 'err:not-ready', msg: `${requester} is not on the server.` }
			if (!ctx.switchRequests.state.requests.some((r) => r.playerId === player.eos)) {
				ctx.sandbox.emu.world.chat(player, 'ChatAll', CMD.triggerString(trigger))
			}
			return { code: 'ok' }
		},
	},
})

// annotated (not `satisfies`) so a stage lookup by the wire's string id resolves; defScenario still infers each
// scenario's own stage keys for authoring, and assigning to the wider type keeps that check
const SCENARIOS: Record<TUT.ScenarioId, ScenarioDef<string>> = { 'layer-queue': layerQueue, 'player-management': playerManagement }

const SCENARIO_METAS: TUT.ScenarioMeta[] = [
	{ id: 'layer-queue', minutes: 10 },
	{ id: 'player-management', minutes: 15 },
]

// scoped, so only the owner ever sees it in the picker; internal enough that the label need not be a message
const DISPLAY_NAME = 'Tutorial'

// ============================== run registry ==============================

type Run = {
	scenarioId: TUT.ScenarioId
	serverId: string
	owner: bigint
	// starting: the server is being stood up (create/enable/setup); active: ready for the client
	phase: 'starting' | 'active'
}

// one active run per user. Module-level like sandbox.server.ts's instances: the process is the source of truth for
// what is running, and a restart forgetting runs is correct -- the ephemeral servers die with the process anyway.
const runs = new Map<bigint, Run>()
const runChanged$ = new Rx.Subject<void>()

// start and abandon are serialized per user so a double-click cannot race a create against a teardown
const startMtxs = new Map<bigint, Mutex>()
function startMtxFor(owner: bigint): Mutex {
	let mtx = startMtxs.get(owner)
	if (!mtx) {
		mtx = new Mutex()
		startMtxs.set(owner, mtx)
	}
	return mtx
}

// stable per user so re-running a tutorial reuses the same server id: caps otel cardinality and the lifecycle map
function serverIdFor(owner: bigint): string {
	return `tutorial-${owner}`
}

function runStateFor(owner: bigint): TUT.RunState {
	const run = runs.get(owner)
	if (!run) return { code: 'none' }
	if (run.phase === 'starting') return { code: 'starting', scenarioId: run.scenarioId }
	return { code: 'active', scenarioId: run.scenarioId, serverId: run.serverId }
}

function stageCtxFor(base: C.Db & CS.AbortSignal, serverId: string, owner: bigint): StageCtx {
	const sandbox = Sandbox.getInstance(serverId)
	if (!sandbox) throw new Error(`tutorial sandbox ${serverId} is not running`)
	return { ...SquadServer.resolveCtx(base, serverId), sandbox, owner }
}

function buildSandboxSettings(owner: bigint, scenario: ScenarioDef<string>, nextLayerId: L.LayerId | null) {
	const pacing = scenario.pacing
	const settings = SETTINGS.PublicServerSettingsSchema.parse({})
	const ids = filterIdsFor(owner)
	return {
		...settings,
		connections: SETTINGS.SandboxConnectionSchema.parse({
			type: 'sandbox',
			serverName: 'SLM Tutorial',
			postMatchDelayMs: pacing.postMatchDelayMs,
			tickChatter: pacing.tickChatter,
			// boot the emulator holding the queue head as next, or SLM's reconcile pulls the emulator's default
			// seed into the queue and displaces the scenario's seeded head
			nextLayerId: nextLayerId ?? undefined,
		}),
		queue: {
			...settings.queue,
			mainPool: {
				...settings.queue.mainPool,
				poolFilter: { filterId: ids.pool, mode: 'include' as const },
				indicateMatches: [ids.indicator],
				// The add walkthrough asks for one faction on both of its picks, so the reader's own additions repeat it
				// within three. That is what the warnings-on-save step demonstrates: a queue that already violated a
				// rule before the edit session warns about nothing, since only new violations stop a save. crossTeam,
				// because consecutive items swap sides and the repeat would otherwise fall on the other persistent team.
				repeatRules: [
					{ field: 'Map' as const, within: 4, autogen: true },
					{ field: 'Layer' as const, within: 7, autogen: true },
					{ field: 'Faction' as const, within: 3, autogen: true, warn: true, crossTeam: true },
				],
			},
		},
		switchRequests: {
			...settings.switchRequests,
			instantSwapLead: scenario.instantSwapLead ?? settings.switchRequests.instantSwapLead,
		},
	}
}

// ============================== the scenario's own filters ==============================

// A run names filters in its pool config, and a pool config naming a filter the install does not have is not a
// soft failure: lowering that constraint fails, which fails the whole layer-status query for the server, so every
// queue row loses its indicators and is badged as a layer that does not exist. Rather than depend on what a given
// install happens to have, a run creates the two filters it narrates and deletes them again afterwards.
//
// Ids carry the id of the user running the tutorial, so concurrent runs never share a row and one run's teardown cannot delete a filter another
// run's server still points at. TUTORIAL_FILTER_PREFIX covers every run's, which is what boot sweeps.
const TUTORIAL_FILTER_PREFIX = 'tutorial-'

function filterIdsFor(owner: bigint) {
	const prefix = `${TUTORIAL_FILTER_PREFIX}${owner}-`
	return { pool: `${prefix}pool`, indicator: `${prefix}large`, all: [`${prefix}pool`, `${prefix}large`] }
}

// The second editor a run stands up so the force-save step has something to override. One identity shared by every
// run rather than one each: presence is keyed by client, so concurrent runs get their own editor from the clientId
// alone, and a per-run user row would have to be deleted while another run might still be pointing at it. The id is
// far below any discord snowflake, so it cannot collide with a person; boot deletes it, when no run holds one.
const PEER_USER_ID = 2n
const PEER_USERNAME = 'Tutorial Admin'
// derived from the server rather than the owner, so a stage can name it from the ctx it already has
function peerClientId(serverId: string) {
	return `${serverId}-peer`
}

async function ensurePeerUser(ctx: C.Db) {
	await ctx
		.db()
		.insert(Schema.discordAccounts)
		.values({ discordId: PEER_USER_ID, username: PEER_USERNAME, updatedAt: new Date(0) })
		.onConflictDoNothing()
	await ctx.db().insert(Schema.users).values({ discordId: PEER_USER_ID }).onConflictDoNothing()
}

// What a run's rows look like, so a sweep matches only those. The prefix alone is not enough: an owner is a
// discord snowflake, and `tutorial-` is a name a person, or a test fixture, may reasonably give something else.
const TUTORIAL_SERVER_ID = /^tutorial-\d+$/
const TUTORIAL_FILTER_ID = /^tutorial-\d+-(?:pool|large)$/

// Chosen against the seeded queue: every layer it holds is OWI and Large, so the pool never warns during the walk
// and the indicator is on every row the tour points at. The layer the add walkthrough asks for is OWI but Medium,
// so it lands in pool without the indicator, which is the distinction those two steps exist to draw.
function buildTutorialFilters(owner: bigint): F.FilterEntity[] {
	const ids = filterIdsFor(owner)
	return [
		{
			id: ids.pool,
			name: TUT.TUTORIAL_FILTERS.pool.name,
			description: 'The layers this tutorial server plays: everything an unmodded Squad server can run.',
			filter: FB.eq('Collection', 'OWI'),
			owner: F.SYSTEM_OWNER,
			emoji: TUT.TUTORIAL_FILTERS.pool.emoji,
			alertMessage: 'In the tutorial pool',
			invertedEmoji: TUT.TUTORIAL_FILTERS.pool.invertedEmoji,
			invertedAlertMessage: 'Not in the tutorial pool',
		},
		{
			id: ids.indicator,
			name: TUT.TUTORIAL_FILTERS.large.name,
			description: 'Layers built for a full server. Worth knowing about before setting one on a quiet night.',
			filter: FB.eq('Size', 'Large'),
			owner: F.SYSTEM_OWNER,
			emoji: TUT.TUTORIAL_FILTERS.large.emoji,
			alertMessage: 'A large layer',
			invertedEmoji: null,
			invertedAlertMessage: null,
		},
	]
}

// drops the caller's run and its server. Idempotent: deleteServer no-ops on a server that is not running and
// reports err:server-not-found on one that was never created, which a teardown does not care about.
// the server goes first: deleting a filter its settings still name would leave exactly the dangling reference
// these per-run filters exist to avoid
async function teardown(ctx: C.Db, owner: bigint) {
	runs.delete(owner)
	runChanged$.next()
	// before the server goes, so the fabricated editor leaves the way a real client would
	await UserPresence.dispatchFabricatedDisconnect(peerClientId(serverIdFor(owner)))
	await SquadServer.deleteServer(serverIdFor(owner))
	await FilterEntity.deleteRuntimeFilters(ctx, filterIdsFor(owner).all)
}

// ============================== stage execution ==============================

// the newest op on every synced stream a stage can write, once it is done. The client waits to have applied them.
type StageResponse =
	| { code: 'ok'; syncedTo: TUT.StageSyncTokens }
	| Exclude<TUT.StageResult, { code: 'ok' }>
	| { code: 'err:stage-failed'; msg: string }

// a second stage call while one is in flight coalesces onto it rather than queueing: both asked for the same state
const inFlightStages = new Map<string, Promise<StageResponse>>()

async function runStage(
	owner: bigint,
	stageId: string,
	getCtx: () => StageCtx,
	stage: (ctx: StageCtx) => Promise<TUT.StageResult>,
): Promise<StageResponse> {
	const key = `${owner}:${stageId}`
	const existing = inFlightStages.get(key)
	if (existing) return existing
	const pending = (async (): Promise<StageResponse> => {
		try {
			const ctx = getCtx()
			const res = await stage(ctx)
			if (res.code !== 'ok') return res
			return {
				code: 'ok',
				syncedTo: {
					presence: UserPresence.lastOpId(),
					queue: ctx.layerQueue.session.ops.at(-1)?.opId,
					teamswaps: ctx.teamswaps.session.ops.at(-1)?.opId,
				},
			}
		} catch (err) {
			log.error(err, 'tutorial stage %s failed', stageId)
			return { code: 'err:stage-failed', msg: err instanceof Error ? err.message : String(err) }
		} finally {
			inFlightStages.delete(key)
		}
	})()
	inFlightStages.set(key, pending)
	return pending
}

// ============================== lifecycle ==============================

// A run's server and its filters are created together and only make sense together, so boot sweeps both: a
// process killed mid-run leaves the server row enabled and its filters behind, and clearing one without the other
// would leave a server pointing at a filter that no longer exists. Nothing else owns this id prefix.
export async function setup(ctx: C.Db) {
	log = module.getLogger()
	const like = `${TUTORIAL_FILTER_PREFIX}%`
	const servers = (await ctx.db().select({ id: Schema.servers.id }).from(Schema.servers).where(E.like(Schema.servers.id, like)))
		.map(({ id }) => id)
		.filter((id) => TUTORIAL_SERVER_ID.test(id))
	for (const id of servers) await SquadServer.deleteServer(id)
	const filterIds = (await ctx.db().select({ id: Schema.filters.id }).from(Schema.filters).where(E.like(Schema.filters.id, like)))
		.map(({ id }) => id)
		.filter((id) => TUTORIAL_FILTER_ID.test(id))
	const filters = await FilterEntity.deleteRuntimeFilters(ctx, filterIds)
	// no run holds the second editor at boot, so its identity goes with them; the user row cascades from the account
	await ctx.db().delete(Schema.discordAccounts).where(E.eq(Schema.discordAccounts.discordId, PEER_USER_ID))
	if (servers.length || filters) log.info('swept %d tutorial servers and %d filters left by an earlier run', servers.length, filters)
}

const start = Instr.spanOp(
	'tutorials.start',
	{ module },
	async (ctx: C.Db & CS.AbortSignal, owner: bigint, scenarioId: TUT.ScenarioId, reader: ReaderClock) => {
		const serverId = serverIdFor(owner)
		// clear any prior run (and any stale server a crashed run left behind) before standing up the new one
		await teardown(ctx, owner)
		runs.set(owner, { scenarioId, serverId, owner, phase: 'starting' })
		runChanged$.next()
		try {
			const scenario = SCENARIOS[scenarioId]
			const initialQueue = scenario.initialQueue(owner)
			await FilterEntity.putRuntimeFilters(ctx, buildTutorialFilters(owner))
			const created = await Settings.createServerEntry(ctx, {
				id: serverId,
				displayName: DISPLAY_NAME,
				settings: buildSandboxSettings(owner, scenario, LL.getNextLayerId(initialQueue)),
				visibility: 'scoped',
				ownerDiscordId: owner,
				layerQueue: initialQueue,
			})
			if (created.code !== 'ok') throw new Error(`could not create tutorial server: ${created.code}`)
			const enabled = await SquadServer.enableServer(serverId)
			if (enabled.code !== 'ok') throw new Error(`could not enable tutorial server: ${enabled.code}`)
			await scenario.setup(stageCtxFor(ctx, serverId, owner), reader)
			runs.set(owner, { scenarioId, serverId, owner, phase: 'active' })
			runChanged$.next()
			return { code: 'ok' as const, serverId }
		} catch (err) {
			log.error(err, 'tutorial start failed for %s', serverId)
			await teardown(ctx, owner)
			return { code: 'err:start-failed' as const }
		}
	},
)

// ============================== progress ==============================

// A user's place in each tutorial, which outlives the run: the server a run stands up is ephemeral and gets
// reaped, but where the reader got to is theirs. Written on every step, so it is one upsert of a tiny row.
async function readProgress(ctx: C.Db, userId: bigint): Promise<TUT.Progress[]> {
	const rows = await ctx.db().select().from(Schema.tutorialProgress).where(E.eq(Schema.tutorialProgress.userId, userId))
	return rows
		.filter((row): row is typeof row & { scenarioId: TUT.ScenarioId } => TUT.ScenarioIdSchema.safeParse(row.scenarioId).success)
		.map((row) => ({ scenarioId: row.scenarioId, stepId: row.stepId, completed: row.completedAt !== null }))
}

async function writeProgress(ctx: C.Db, userId: bigint, progress: TUT.Progress) {
	const completedAt = progress.completed ? new Date() : null
	await ctx
		.db()
		.insert(Schema.tutorialProgress)
		.values({ userId, scenarioId: progress.scenarioId, stepId: progress.stepId, completedAt, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: [Schema.tutorialProgress.userId, Schema.tutorialProgress.scenarioId],
			// completion is not undone by starting the tutorial again, so it only ever goes from null to a date
			set: {
				stepId: progress.stepId,
				updatedAt: new Date(),
				...(completedAt ? { completedAt } : {}),
			},
		})
}

// ============================== page prompts ==============================

// Which pages the user has told to stop offering their tutorials. A row per dismissal, so nothing is written for
// the ordinary case of never having dismissed one.
async function readDismissedPrompts(ctx: C.Db, userId: bigint): Promise<TUT.SurfaceId[]> {
	const rows = await ctx.db().select().from(Schema.tutorialPromptDismissals).where(E.eq(Schema.tutorialPromptDismissals.userId, userId))
	return rows
		.map((row) => TUT.SurfaceIdSchema.safeParse(row.surfaceId))
		.filter((parsed) => parsed.success)
		.map((parsed) => parsed.data)
}

export const orpcRouter = {
	list: orpcBase.handler(async () => SCENARIO_METAS),

	// as with progress: the caller's own, so there is no rbac check to make
	getDismissedPrompts: orpcBase.handler(async ({ context }) => readDismissedPrompts(context, context.user.discordId)),

	dismissPrompt: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ surfaceId: TUT.SurfaceIdSchema }))
		.handler(async ({ context, input }) => {
			await context
				.db()
				.insert(Schema.tutorialPromptDismissals)
				.values({ userId: context.user.discordId, surfaceId: input.surfaceId, dismissedAt: new Date() })
				.onConflictDoNothing()
			return { code: 'ok' as const }
		}),

	// the caller's own progress, like watchRun: per-user by construction, so there is no rbac check to make
	getProgress: orpcBase.handler(async ({ context }) => readProgress(context, context.user.discordId)),

	saveProgress: orpcBase
		.meta({ type: 'mutation', logLevel: 'trace' })
		.input(TUT.ProgressSchema)
		.handler(async ({ context, input }) => {
			await writeProgress(context, context.user.discordId, input)
			return { code: 'ok' as const }
		}),

	// the caller's own run; per-user by construction, so there is no rbac check to make
	watchRun: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context, signal }) {
		const obs = runChanged$.pipe(
			Rx.startWith(undefined),
			Rx.map(() => runStateFor(context.user.discordId)),
			Rx.Ext.distinctDeepEquals(),
			Rx.Ext.withAbortSignal(signal!),
		)
		yield* Rx.Ext.toAsyncGenerator(obs)
	}),

	start: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ scenarioId: TUT.ScenarioIdSchema, msIntoDay: z.number().int().min(0).max(86_400_000) }))
		.handler(async ({ context, input }) => {
			const owner = context.user.discordId
			return await startMtxFor(owner).runExclusive(() => start(context, owner, input.scenarioId, { msIntoDay: input.msIntoDay }))
		}),

	stage: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ scenarioId: TUT.ScenarioIdSchema, stageId: TUT.StageIdSchema }))
		.handler(async ({ context, input }) => {
			const owner = context.user.discordId
			const run = runs.get(owner)
			if (!run || run.scenarioId !== input.scenarioId || run.phase !== 'active') return { code: 'err:no-active-run' as const }
			const stage = SCENARIOS[run.scenarioId].stages[input.stageId]
			if (!stage) return { code: 'err:unknown-stage' as const }
			return await runStage(owner, input.stageId, () => stageCtxFor(context, run.serverId, owner), stage)
		}),

	abandon: orpcBase.meta({ type: 'mutation' }).handler(async ({ context }) => {
		const owner = context.user.discordId
		await startMtxFor(owner).runExclusive(() => teardown(context, owner))
		return { code: 'ok' as const }
	}),
}
