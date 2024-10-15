import { toAsyncGenerator, traceTag } from '@/lib/async.ts'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models.ts'
import { Context } from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import * as S from '@/server/schema.ts'
import * as SquadServer from '@/server/systems/squad-server.ts'
import { tracked } from '@trpc/server'
import { eq, inArray } from 'drizzle-orm'
import { Logger } from 'pino'
import { Observable, Subject, interval, share, shareReplay, startWith, switchMap } from 'rxjs'

const runId = Math.floor(Math.random() * 1000000)
function getTrackingId(seqId: number) {
	return `${runId}-${seqId}`
}
const startingQueue: M.LayerQueue = [
	{ layerId: 'AB-RAAS-V1:USMC-MT:RGF-SP', generated: true },
	{ layerId: 'KD-RAAS-V1:INS-SP:RGF-MT', generated: true },
	{ layerId: 'KH-TC-V1:MEA-SP:WPMC-AA', generated: true },
	{ layerId: 'KH-TC-V1:VDV-SP:ADF-AA', generated: true },
	{ layerId: 'AB-AAS-V1:USMC-CA:RGF-CA', generated: true },
	{ layerId: 'AB-RAAS-V1:USA-LI:PLANMC-MT', generated: true },
	{ layerId: 'BC-RAAS-V1:PLANMC-AR:USMC-AR', generated: true },
	// { layerId: 'BL-AAS-V1:IMF-MZ:RGF-LI', generated: true },
	// { layerId: 'AN-RAAS-V1:ADF-CA:WPMC-LI', generated: true },
	// { layerId: 'BC-RAAS-V1:USA-MZ:PLANMC-AR', generated: true },
	// { layerId: 'KD-AAS-V1:PLA-SP:CAF-AA' },
	// { layerId: 'KK-Skirmish-V1:INS-CA:WPMC-CA' },
	// { layerId: 'TL-AAS-V1:MEA-SP:PLA-LI' },
	// { layerId: 'TL-RAAS-V1:USA-MZ:INS-CA' },
	// { layerId: 'LK-TC-V2:RGF-AR:ADF-MZ' },
	// { layerId: 'MN-RAAS-V1:USA-AR:RGF-AR' },
	// { layerId: 'TL-TC-V1:RGF-LI:MEA-AR' },
	// { layerId: 'LK-TC-V1:RGF-CA:TLF-AA' },
	// { layerId: 'NV-TC-V1:CAF-MZ:RGF-AR' },
	// { layerId: 'KD-RAAS-V1:USMC-MT:VDV-CA' },
]
const serverState: M.ServerState = {
	seqId: 0,
	queue: [...startingQueue],
	nowPlaying: null,
	poolFilterId: null,
}

export const serverStateSubject = new Subject<M.ServerState>()
let queueUpdateDenorm$!: Observable<M.ServerState_Denorm>
let pollServerInfo$!: Observable<SM.ServerStatus>
export function setupLayerQueue() {
	const log = baseLogger.child({ ctx: 'layer-queue' })
	const ctx = { log }
	const db = DB.get(ctx)
	queueUpdateDenorm$ = serverStateSubject.pipe(
		traceTag('layerQueueUpdateDenorm$', ctx),
		switchMap((update) => getQueueUpdateDenorm(update, { ...ctx, db })),
		share()
	)
	pollServerInfo$ = interval(3000).pipe(
		traceTag('pollServerInfo$', ctx),
		startWith(0),
		switchMap(SquadServer.getServerStatus),
		shareReplay(1)
	)
}

export async function* watchNowPlaying() {
	for await (const update of toAsyncGenerator(queueUpdateDenorm$)) {
		yield tracked(getTrackingId(update.seqId), update)
	}
}

export async function* watchUpdates({ ctx }: { ctx: Context }) {
	{
		const db = DB.get(ctx)
		const updateDenorm = await getQueueUpdateDenorm(serverState, { ...ctx, db })
		yield tracked(getTrackingId(updateDenorm.seqId), updateDenorm)
	}

	for await (const update of toAsyncGenerator(queueUpdateDenorm$)) {
		yield tracked(getTrackingId(update.seqId), update)
	}
}

export async function* pollServerInfo() {
	for await (const info of toAsyncGenerator(pollServerInfo$)) {
		yield info
	}
}

async function getQueueUpdateDenorm(update: M.ServerState, ctx: { log: Logger; db: DB.Db }): Promise<M.ServerState_Denorm> {
	const layerIds = update.queue.map((layer) => layer.layerId).filter((id) => !!id) as string[]
	if (update.nowPlaying) {
		layerIds.push(update.nowPlaying)
	}
	const layerIdsWithSwapped = [...layerIds]
	for (const id of layerIds) {
		layerIdsWithSwapped.push(M.swapFactionsInId(id))
	}
	const layersPromise = (async () => await ctx.db.select().from(S.layers).where(inArray(S.layers.id, layerIdsWithSwapped)))()
	let poolFilterPromise: Promise<undefined | M.FilterEntity> = Promise.resolve(undefined)

	if (update.poolFilterId) {
		poolFilterPromise = (async () => {
			let filter: M.FilterEntity | null
			if (update.poolFilterId !== null) {
				const [_filter] = await ctx.db.select().from(S.filters).where(eq(S.filters.id, update.poolFilterId))
				filter = _filter as M.FilterEntity
				if (!filter) throw new Error('filter ' + update.poolFilterId + " doesn't exist")
			} else {
				filter = null
			}
			return filter as M.FilterEntity
		})()
	}

	return {
		...update,
		layers: await layersPromise,
		poolFilter: await poolFilterPromise,
	}
}

export function update(update: M.ServerState) {
	if (update.seqId !== serverState.seqId) {
		return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
	}
	serverState.nowPlaying = update.nowPlaying
	serverState.queue = update.queue
	serverState.seqId++
	serverStateSubject.next(serverState)
	return { code: 'ok' as const }
}
