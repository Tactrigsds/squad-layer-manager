import { toAsyncGenerator } from '@/lib/rxjs.ts'
import * as M from '@/models.ts'
import { db } from '@/server/db.ts'
import * as S from '@/server/schema.ts'
import * as Rcon from '@/server/systems/rcon'
import { tracked } from '@trpc/server'
import { eq, inArray } from 'drizzle-orm'
import { Subject, interval, share, shareReplay, startWith, switchMap, tap } from 'rxjs'

const startingQueue: M.LayerQueue = [
	{ layerId: 'AB-RAAS-V1:USMC-MT:RGF-SP' },
	{ layerId: 'KD-RAAS-V1:INS-SP:RGF-MT' },
	{ layerId: 'KH-TC-V1:MEA-SP:WPMC-AA' },
	{ layerId: 'KH-TC-V1:VDV-SP:ADF-AA' },
	{ layerId: 'AB-AAS-V1:USMC-CA:RGF-CA' },
	{ layerId: 'AB-RAAS-V1:USA-LI:PLANMC-MT' },
	{ layerId: 'BC-RAAS-V1:PLANMC-AR:USMC-AR' },
	{ layerId: 'BL-AAS-V1:IMF-MZ:RGF-LI' },
	{ layerId: 'AN-RAAS-V1:ADF-CA:WPMC-LI' },
	{ layerId: 'BC-RAAS-V1:USA-MZ:PLANMC-AR' },
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
let layerQueue: M.LayerQueue = [...startingQueue]
let seqId: number = 0
export const queueUpdateSubject = new Subject<M.LayerQueueUpdate>()

export let nowPlaying: string = 'BL-AAS-V1:IMF-MZ:RGF-LI'
const queueUpdateDenorm$ = queueUpdateSubject.pipe(
	switchMap((update) => getQueueUpdateDenorm(update)),
	share()
)

export async function* watchNowPlaying() {
	for await (const update of toAsyncGenerator(queueUpdateDenorm$)) {
		if (!update) return
		yield tracked(update.seqId.toString(), update)
	}
}

export async function* watchUpdates() {
	const updateDenorm = await getQueueUpdateDenorm({ seqId: 0, queue: layerQueue, nowPlaying })
	yield tracked(updateDenorm.seqId.toString(), updateDenorm)

	for await (const update of toAsyncGenerator(queueUpdateDenorm$)) {
		if (!update) continue
		yield tracked(update.seqId.toString(), updateDenorm)
	}
}

let serverInfo: M.ServerStatus | null = null
const pollServerInfo$ = interval(30000).pipe(startWith(0), switchMap(Rcon.fetchServerStatus), shareReplay(1))

export async function* pollServerInfo() {
	for await (const info of toAsyncGenerator(pollServerInfo$)) {
		if (!info) continue
		yield info
	}
}

async function getQueueUpdateDenorm(update: M.LayerQueueUpdate): Promise<M.LayerQueueUpdate_Denorm> {
	const layerIds = update.queue.map((layer) => layer.layerId).filter((id) => !!id) as string[]
	if (update.nowPlaying) {
		layerIds.push(update.nowPlaying)
	}
	const layers = await db.select().from(S.layers).where(inArray(S.layers.id, layerIds))
	return {
		...update,
		layers,
	}
}

export function update(update: M.LayerQueueUpdate) {
	if (update.seqId + 1 !== layerQueue.length) {
		return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
	}
	layerQueue = update.queue
	seqId = update.seqId + 1
	queueUpdateSubject.next({ ...update, seqId })
	return { code: 'ok' as const }
}
