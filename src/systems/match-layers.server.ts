import * as E from 'drizzle-orm'
import * as Timers from 'node:timers/promises'

import * as Schema from '$root/drizzle/schema'
import * as Arr from '@/lib/array-utils'
import * as Prom from '@/lib/promise-utils'
import * as ZodUtils from '@/lib/zod-utils'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared.models'
import * as L from '@/models/layer.models'
import * as MH from '@/models/match-history.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as LayerData from '@/systems/layer-data.server'
import * as PersistedCache from '@/systems/persistedCache.server'

const module = initModule('match-layers')
const SQL = Sql.forModule(module)
let log!: CS.Logger

// far enough into boot that the layer artifact is loaded and the first matches have settled; the pass takes a
// write lock per match it resolves, and on the run that backfills history that is every match it can resolve
const BOOT_SETTLE_DELAY = ZodUtils.parseHumanTime('2m')

export function setup() {
	log = module.getLogger()
	void runAtBoot()
}

// once per boot, and a no-op on every boot whose layer artifact matches the last one reconciled against
async function runAtBoot() {
	const ctx = DB.withDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
	try {
		await Timers.setTimeout(BOOT_SETTLE_DELAY, undefined, { signal: ctx.signal })
		await reconcileMatchLayers(ctx)
	} catch (err) {
		if (!Prom.isAbortError(err)) log.error(err, 'match layer reconciliation failed')
	}
}

const RECONCILED_HASH_KEY = 'matchLayers.reconciledArtifactHash'

// how many layers (or matches, in the rewrite pass) one write transaction covers. Small enough that the
// process-wide write lock is never held long, since this runs while the app is already serving.
const UPDATE_BATCH = 250

const PARTS_COLUMNS = {
	layerMap: Schema.matchHistory.layerMap,
	layerGamemode: Schema.matchHistory.layerGamemode,
	layerVersion: Schema.matchHistory.layerVersion,
	layerTeam1Faction: Schema.matchHistory.layerTeam1Faction,
	layerTeam1Unit: Schema.matchHistory.layerTeam1Unit,
	layerTeam2Faction: Schema.matchHistory.layerTeam2Faction,
	layerTeam2Unit: Schema.matchHistory.layerTeam2Unit,
}
function partsSet(p: Sql.Params<typeof PARTS_COLUMNS>) {
	return {
		layerMap: p.layerMap,
		layerGamemode: p.layerGamemode,
		layerVersion: p.layerVersion,
		layerTeam1Faction: p.layerTeam1Faction,
		layerTeam1Unit: p.layerTeam1Unit,
		layerTeam2Faction: p.layerTeam2Faction,
		layerTeam2Unit: p.layerTeam2Unit,
	}
}

namespace Q {
	export const countUnresolved = SQL.def(
		'countUnresolved',
		SQL.params({}),
		SQL.select({ count: E.count() }).from(Schema.matchHistory).where(E.isNull(Schema.matchHistory.layerMap)),
	)
	export const unresolvedLayerIds = SQL.def(
		'unresolvedLayerIds',
		SQL.params({}),
		SQL.selectDistinct({ layerId: Schema.matchHistory.layerId }).from(Schema.matchHistory).where(E.isNull(Schema.matchHistory.layerMap)),
	)
	const setPartsP = SQL.params({ ...PARTS_COLUMNS, layerId: Schema.matchHistory.layerId })
	export const setUnresolvedParts = SQL.def(
		'setUnresolvedParts',
		setPartsP,
		SQL.update(Schema.matchHistory)
			.set(partsSet(setPartsP))
			.where(E.and(E.eq(Schema.matchHistory.layerId, setPartsP.layerId), E.isNull(Schema.matchHistory.layerMap))),
	)
	export const unresolvedWithCommandText = SQL.def(
		'unresolvedWithCommandText',
		SQL.params({}),
		SQL.select({
			id: Schema.matchHistory.id,
			layerId: Schema.matchHistory.layerId,
			rawLayerCommandText: Schema.matchHistory.rawLayerCommandText,
		})
			.from(Schema.matchHistory)
			.where(E.and(E.isNull(Schema.matchHistory.layerMap), E.isNotNull(Schema.matchHistory.rawLayerCommandText))),
	)
	const rewriteLayerP = SQL.params({ ...PARTS_COLUMNS, layerId: Schema.matchHistory.layerId, id: Schema.matchHistory.id })
	export const rewriteLayer = SQL.def(
		'rewriteLayer',
		rewriteLayerP,
		SQL.update(Schema.matchHistory)
			.set({ layerId: rewriteLayerP.layerId, ...partsSet(rewriteLayerP) })
			.where(E.eq(Schema.matchHistory.id, rewriteLayerP.id)),
	)
}

/**
 * Re-resolves matches whose layer this build's engine could not parse when they were recorded.
 *
 * A match stores its layer parts so layer-filtered searches never call the engine per row, and a layer the
 * engine cannot resolve stores none -- which keeps it out of those searches rather than mismatching them.
 * That verdict is only as good as the artifact that produced it, so a new one is a reason to ask again: a
 * layer added since, or a RAW: id whose command text names a layer the engine now knows.
 *
 * Keyed on the artifact hash rather than a schedule, because that is the only thing that can change the
 * answer. rawLayerCommandText holds the original command, so rewriting layerId here is reversible.
 *
 * The first run after the layer-parts columns are added has no recorded hash, so it visits every match and
 * doubles as their backfill.
 */
export const reconcileMatchLayers = Instr.spanOp('reconcileMatchLayers', { module }, async (ctx: C.Db & CS.AbortSignal) => {
	const artifactHash = LayerData.hash
	const lastHash = PersistedCache.load<string>(RECONCILED_HASH_KEY)
	if (lastHash === artifactHash) return undefined

	// unresolved is exactly "layerMap is null": layerParts writes all seven columns or none of them
	const unresolvedTotal = DB.get(ctx, Q.countUnresolved({}))?.count ?? 0

	// By distinct layer rather than by match: an id resolves the same way for every match that played it, and
	// there are far fewer ids than matches (5k against 8.5k on the largest install, and the gap only widens).
	// A RAW: id carries its command text inside itself, so this pass covers those too.
	const distinctIds = DB.all(ctx, Q.unresolvedLayerIds({}))

	let updated = 0

	for (const batch of Arr.paged(distinctIds, UPDATE_BATCH)) {
		ctx.signal.throwIfAborted()
		updated += DB.transaction(ctx, {}, (ctx) => {
			let changes = 0
			for (const { layerId } of batch) {
				const parts = MH.layerParts(L.readStoredLayerId(layerId))
				if (parts.layerMap === null) continue
				changes += DB.run(ctx, Q.setUnresolvedParts({ ...parts, layerId })).changes
			}
			return { code: 'ok' as const, changes }
		}).changes
		await Timers.setImmediate(undefined, { signal: ctx.signal })
	}

	// what is left is an id the engine still cannot place. Those are worth a second look one at a time,
	// because rawLayerCommandText may name a layer the id does not -- and rewriting the id is the only case
	// where a match's recorded layer changes, so it stays per row and stays attributable.
	const stillUnresolved = DB.all(ctx, Q.unresolvedWithCommandText({}))

	// only the rewrites are listed on the event. A plain backfill resolves thousands of ids to themselves,
	// which the count already says; an id that CHANGED is the part that alters what a search returns.
	const rewritten = new Map<string, { from: string; to: string; matches: number }>()
	for (const batch of Arr.paged(stillUnresolved, UPDATE_BATCH)) {
		ctx.signal.throwIfAborted()
		DB.transaction(ctx, {}, (ctx) => {
			for (const match of batch) {
				const parsed = L.parseRawLayerText(match.rawLayerCommandText!)
				if (!parsed || !L.isKnownLayer(parsed)) continue
				const parts = MH.layerParts(parsed.id)
				if (parts.layerMap === null) continue
				const to = L.toLayerText(parsed.id)
				DB.run(ctx, Q.rewriteLayer({ ...parts, layerId: to, id: match.id }))
				const key = `${match.layerId} ${to}`
				const entry = rewritten.get(key) ?? { from: match.layerId, to, matches: 0 }
				entry.matches++
				rewritten.set(key, entry)
				updated++
			}
		})
		await Timers.setImmediate(undefined, { signal: ctx.signal })
	}
	const resolved = [...rewritten.values()]

	PersistedCache.save(RECONCILED_HASH_KEY, artifactHash)

	if (updated > 0) {
		log.info('reconciled the layers of %d match(es) against artifact %s', updated, artifactHash.slice(0, 12))
		AppEventsSys.persistAppEvent(
			ctx,
			AppEvents.create<AppEvents.MatchLayersReconciled>({
				type: 'MATCH_LAYERS_RECONCILED',
				actor: { type: 'system' },
				serverId: null,
				matchId: null,
				causeId: null,
				layerDataHash: artifactHash,
				matchesUpdated: updated,
				resolved,
				unresolvedRemaining: unresolvedTotal - updated,
			}),
		)
	}

	return { updated, unresolvedRemaining: unresolvedTotal - updated }
})
