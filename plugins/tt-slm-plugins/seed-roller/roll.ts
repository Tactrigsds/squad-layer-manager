// Preparing the queue for a seeding roll, and getting the game server to agree about it.
//
// The queue work is deliberately separate from the countdown that triggers it: it runs while admins still
// have time to cancel, so a cancel leaves a correct queue rather than a half-edited one, and a failure is
// reported before anybody is told a roll is coming.

import * as CB from 'slm/models/constraint-builders'
import * as L from 'slm/models/layer'
import type * as P from 'slm/plugin'
import * as LayerQueries from 'slm/systems/layer-queries'
import * as LayerQueue from 'slm/systems/layer-queue'
import * as SquadRcon from 'slm/systems/squad-rcon'

import type manifest from './plugin.ts'

type Ctx = P.ServerCtx<typeof manifest>

export function isSeedLayer(layerId: string): boolean {
	return L.toLayer(layerId).Gamemode === 'Seed'
}

export function isTrainingLayer(layerId: string): boolean {
	return L.toLayer(layerId).Gamemode === 'Training'
}

export type PrepareResult =
	| { code: 'ok'; seedLayerId: string; followUpLayerId: string }
	| { code: 'err:unsaved-edits' }
	| { code: 'err:no-pool'; pool: 'seed' | 'follow-up' }
	| { code: 'err:empty-pool'; pool: 'seed' | 'follow-up' }
	| { code: 'err:queue'; message: string }

/** Draws one layer at random from a filter. The seed keeps a retry within an armed roll drawing the same one. */
async function draw(ctx: Ctx, filterId: string, seed: string): Promise<string | null> {
	if (!filterId) return null
	const res = await LayerQueries.query(ctx, {
		pageSize: 1,
		sort: { type: 'random', seed },
		constraints: [CB.filterEntity('seed-roller-pool', filterId)],
	})
	if (res.code !== 'ok') {
		ctx.log.warn('filter %s did not resolve: %s', filterId, res.errors.map((e) => e.path.join('.')).join('; '))
		return null
	}
	return res.layers[0]?.id ?? null
}

/**
 * Puts a seeding layer at the head of the queue with something real behind it, and drops every other
 * training layer, which is what the roll exists to get away from.
 *
 * A seeding layer an admin already queued is left alone: they have decided what plays next. The layer behind
 * it is replaced only when it is missing or generated, since a generated item is a placeholder SLM invented
 * to keep the queue non-empty rather than anybody's choice.
 *
 * Repeat rules are deliberately not applied. A seeding layer is played because the server is empty, not
 * because it is due.
 */
export async function prepareQueue(ctx: Ctx, cfg: { seedPool: string; followUpPool: string }, seed: string): Promise<PrepareResult> {
	const kept = LayerQueue.getSavedQueue(ctx).filter((item) => !isTrainingLayer(item.layerId))
	const headIsSeed = kept.length > 0 && isSeedLayer(kept[0].layerId)
	const tail = headIsSeed ? kept.slice(1) : kept

	if (!headIsSeed && !cfg.seedPool) return { code: 'err:no-pool', pool: 'seed' }
	const seedLayerId = headIsSeed ? kept[0].layerId : await draw(ctx, cfg.seedPool, `${seed}:seed`)
	if (!seedLayerId) return { code: 'err:empty-pool', pool: 'seed' }

	const keptFollowUp = tail.length > 0 && tail[0].source.type !== 'generated' ? tail[0] : undefined
	if (!keptFollowUp && !cfg.followUpPool) return { code: 'err:no-pool', pool: 'follow-up' }
	const drawnFollowUp = keptFollowUp ? null : await draw(ctx, cfg.followUpPool, `${seed}:follow-up`)
	if (!keptFollowUp && !drawnFollowUp) return { code: 'err:empty-pool', pool: 'follow-up' }

	const res = await LayerQueue.editSaved(ctx, (entries) => {
		const surviving = entries.filter((e) => !isTrainingLayer(e.layerId))
		const head = surviving.length > 0 && isSeedLayer(surviving[0].layerId) ? surviving[0] : seedLayerId
		const rest = typeof head === 'string' ? surviving : surviving.slice(1)
		if (!drawnFollowUp) return [head, ...rest]
		// drop the placeholder being replaced; a missing follow-up leaves nothing to drop
		return [head, drawnFollowUp, ...(rest.length > 0 && rest[0].generated ? rest.slice(1) : rest)]
	})
	if (res.code === 'err:unsaved-edits') return { code: 'err:unsaved-edits' }
	if (res.code !== 'ok') return { code: 'err:queue', message: res.code }

	return { code: 'ok', seedLayerId, followUpLayerId: keptFollowUp?.layerId ?? drawnFollowUp! }
}

/**
 * Waits for SLM's next-layer sync to reach the game server. Ending the match before it lands would roll onto
 * whatever the server still thinks is next, which is the layer the edit just displaced.
 */
export async function waitForNextLayer(ctx: Ctx, layerId: string, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline && !ctx.signal.aborted) {
		const res = await SquadRcon.getNextLayer(ctx)
		// compatible, not equal: the game reports an FRAAS layer back as its RAAS counterpart, so a strict
		// comparison never matches one. This is the same check the host's own sync makes.
		if (res.code === 'ok' && res.layer && L.areLayersCompatible(res.layer, layerId)) return true
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
	return false
}
