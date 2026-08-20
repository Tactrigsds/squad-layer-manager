import { Mutex } from 'async-mutex'
import { z } from 'zod'

import * as Verbs from '@/emulator/verbs'
import * as Rx from '@/lib/rxjs'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as LQ from '@/models/layer-queue.models'
import type * as MH from '@/models/match-history.models'
import * as SettingsModels from '@/models/settings.models'
import type * as SQS from '@/models/squad-server.models'
import * as TUT from '@/models/tutorial.models'
import type * as C from '@/server/context'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as Sandbox from '@/systems/sandbox.server'
import * as Seed from '@/systems/seed.server'
import * as Settings from '@/systems/settings.server'
import * as SquadServer from '@/systems/squad-server.server'

// The tutorial runtime. A run is one scoped, ephemeral emulated server (src/emulator, via sandbox.server) staged
// for a scenario, with a coachmark tour narrating the real dashboard on top of it. This file is the server half:
// the run registry, the lifecycle that stands a server up and tears it down, the staging helpers a scenario drives
// it with, and the oRPC surface the client talks to. The client half is the tour engine (Phase 5); the model
// (schemas, importable from the client) is src/models/tutorial.models.ts.

const module = initModule('tutorials')
const orpcBase = getOrpcBase(module)
let log!: CS.Logger

// what a stage runs against: the managed server's usual surface plus the sandbox instance it drives. A helper
// needing less narrows, per the minimum-ctx rule.
export type StageCtx = C.Db & SQS.Ctx & LQ.Ctx & MH.Ctx & CS.AbortSignal & { sandbox: Sandbox.SandboxInstance }

type ScenarioDef<S extends string> = {
	id: TUT.ScenarioId
	// instance policy: every scenario states its own pacing, because the emulator's defaults are tuned for realism,
	// not narration (a ~30s post-match wait and constant tick chatter)
	pacing: { postMatchDelayMs: number; tickChatter: boolean }
	// the saved queue the server boots with. Seeded declaratively through createServerEntry rather than dispatched
	// after enable: at creation there is no client, no vote and no sync to reproduce the production way.
	initialQueue: (owner: bigint) => LL.List
	// runs once inside start(), after enable and before the client sees the server
	setup: (ctx: StageCtx) => Promise<void>
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

// ============================== scenarios ==============================

// valid layer ids from the layer db that ships with the app, so they survive a round trip through its queries
const LQB_QUEUE: L.LayerId[] = ['GD-RAAS-V1:USA-CA:RGF-CA', 'HJ-RAAS-V1:RGF-MZ:PLA-AA', 'NV-RAAS-V1:USA-CA:RGF-CA']

const layerQueue = defScenario({
	id: 'layer-queue',
	// a short post-match wait so a staged roll does not stall the tour; no tick chatter so the narrated log stays legible
	pacing: { postMatchDelayMs: 2000, tickChatter: false },
	initialQueue: (owner) =>
		LQB_QUEUE.map((layerId) => LL.createItem({ type: 'single-list-item', layerId }, { type: 'manual', userId: owner })),
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
	},
})

// annotated (not `satisfies`) so a stage lookup by the wire's string id resolves; defScenario still infers each
// scenario's own stage keys for authoring, and assigning to the wider type keeps that check
const SCENARIOS: Record<TUT.ScenarioId, ScenarioDef<string>> = { 'layer-queue': layerQueue }

const SCENARIO_METAS: TUT.ScenarioMeta[] = [{ id: 'layer-queue', minutes: 10 }]

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

function stageCtxFor(base: C.Db & CS.AbortSignal, serverId: string): StageCtx {
	const sandbox = Sandbox.getInstance(serverId)
	if (!sandbox) throw new Error(`tutorial sandbox ${serverId} is not running`)
	return { ...SquadServer.resolveCtx(base, serverId), sandbox }
}

async function buildSandboxSettings(ctx: C.Db, pacing: ScenarioDef<string>['pacing'], nextLayerId: L.LayerId | null) {
	const settings = Seed.applyInitialPoolConfig({
		...SettingsModels.PublicServerSettingsSchema.parse({}),
		connections: SettingsModels.SandboxConnectionSchema.parse({
			type: 'sandbox',
			serverName: 'SLM Tutorial',
			postMatchDelayMs: pacing.postMatchDelayMs,
			tickChatter: pacing.tickChatter,
			// boot the emulator holding the queue head as next, or SLM's reconcile pulls the emulator's default
			// seed into the queue and displaces the scenario's seeded head
			nextLayerId: nextLayerId ?? undefined,
		}),
	})
	return { ...settings, queue: { ...settings.queue, mainPool: await prunePoolConfig(ctx, settings.queue.mainPool) } }
}

// The seeded pool config names the filters a fresh install gets, and an install that never had them (or deleted
// one) leaves this server pointing at a filter that does not exist. That is not a soft failure: lowering the
// constraint fails, the layer-status query errors out whole, and every queue row then renders with no indicators
// and a "layer does not exist" badge. Keep only what this install actually has.
async function prunePoolConfig(ctx: C.Db, pool: SettingsModels.PoolConfiguration): Promise<SettingsModels.PoolConfiguration> {
	const present = await FilterEntity.selectFilterIds(ctx)
	const pruned = { ...pool, poolFilter: pool.poolFilter && present.has(pool.poolFilter.filterId) ? pool.poolFilter : null }
	for (const key of SettingsModels.SECONDARY_LIST_KEYS) {
		pruned[key] = (pool[key] as { filterId: string }[]).filter((entry) =>
			present.has(typeof entry === 'string' ? entry : entry.filterId),
		) as never
	}
	return pruned
}

// drops the caller's run and its server. Idempotent: deleteServer no-ops on a server that is not running and
// reports err:server-not-found on one that was never created, which a teardown does not care about.
async function teardown(owner: bigint) {
	runs.delete(owner)
	runChanged$.next()
	await SquadServer.deleteServer(serverIdFor(owner))
}

// ============================== stage execution ==============================

type StageResponse = TUT.StageResult | { code: 'err:stage-failed'; msg: string }

// a second stage call while one is in flight coalesces onto it rather than queueing: both asked for the same state
const inFlightStages = new Map<string, Promise<StageResponse>>()

async function runStage(owner: bigint, stageId: string, run: () => Promise<TUT.StageResult>): Promise<StageResponse> {
	const key = `${owner}:${stageId}`
	const existing = inFlightStages.get(key)
	if (existing) return existing
	const pending = (async (): Promise<StageResponse> => {
		try {
			return await run()
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

export function setup() {
	log = module.getLogger()
}

const start = Instr.spanOp('tutorials.start', { module }, async (ctx: C.Db & CS.AbortSignal, owner: bigint, scenarioId: TUT.ScenarioId) => {
	const serverId = serverIdFor(owner)
	// clear any prior run (and any stale server a crashed run left behind) before standing up the new one
	await teardown(owner)
	runs.set(owner, { scenarioId, serverId, owner, phase: 'starting' })
	runChanged$.next()
	try {
		const scenario = SCENARIOS[scenarioId]
		const initialQueue = scenario.initialQueue(owner)
		const created = await Settings.createServerEntry(ctx, {
			id: serverId,
			displayName: DISPLAY_NAME,
			settings: await buildSandboxSettings(ctx, scenario.pacing, LL.getNextLayerId(initialQueue)),
			visibility: 'scoped',
			ownerDiscordId: owner,
			layerQueue: initialQueue,
		})
		if (created.code !== 'ok') throw new Error(`could not create tutorial server: ${created.code}`)
		const enabled = await SquadServer.enableServer(serverId)
		if (enabled.code !== 'ok') throw new Error(`could not enable tutorial server: ${enabled.code}`)
		await scenario.setup(stageCtxFor(ctx, serverId))
		runs.set(owner, { scenarioId, serverId, owner, phase: 'active' })
		runChanged$.next()
		return { code: 'ok' as const, serverId }
	} catch (err) {
		log.error(err, 'tutorial start failed for %s', serverId)
		await teardown(owner)
		return { code: 'err:start-failed' as const }
	}
})

export const orpcRouter = {
	list: orpcBase.handler(async () => SCENARIO_METAS),

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
		.input(z.object({ scenarioId: TUT.ScenarioIdSchema }))
		.handler(async ({ context, input }) => {
			const owner = context.user.discordId
			return await startMtxFor(owner).runExclusive(() => start(context, owner, input.scenarioId))
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
			return await runStage(owner, input.stageId, () => stage(stageCtxFor(context, run.serverId)))
		}),

	abandon: orpcBase.meta({ type: 'mutation' }).handler(async ({ context }) => {
		const owner = context.user.discordId
		await startMtxFor(owner).runExclusive(() => teardown(owner))
		return { code: 'ok' as const }
	}),
}
