import { toAsyncGenerator } from '@/lib/rxjs.ts'
import * as M from '@/models.ts'
import { tracked } from '@trpc/server'
import { Mutex } from 'async-mutex'
import { eq, inArray } from 'drizzle-orm'
import { Subject, share, switchMap } from 'rxjs'

import { db } from './db.ts'
import * as S from './schema.ts'

let seqId = 0
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
	{ layerId: 'KD-AAS-V1:PLA-SP:CAF-AA' },
	{ layerId: 'KK-Skirmish-V1:INS-CA:WPMC-CA' },
	{ layerId: 'TL-AAS-V1:MEA-SP:PLA-LI' },
	{ layerId: 'TL-RAAS-V1:USA-MZ:INS-CA' },
	{ layerId: 'LK-TC-V2:RGF-AR:ADF-MZ' },
	{ layerId: 'MN-RAAS-V1:USA-AR:RGF-AR' },
	{ layerId: 'TL-TC-V1:RGF-LI:MEA-AR' },
	{ layerId: 'LK-TC-V1:RGF-CA:TLF-AA' },
	{ layerId: 'NV-TC-V1:CAF-MZ:RGF-AR' },
	{ layerId: 'KD-RAAS-V1:USMC-MT:VDV-CA' },
]
let queue: M.LayerQueue = [...startingQueue]
let seqId: number = 0
export const queueUpdateSubject = new Subject<M.LayerQueueUpdate>()

export let nowPlaying: string = 'BL-AAS-V1:IMF-MZ:RGF-LI'
const queueUpdateDenorm$ = queueUpdateSubject.pipe(
	switchMap((update) => getQueueUpdateDenorm(update)),
	share()
)

export async function* watchNowPlaying() {
	for await (const update of toAsyncGenerator(queueUpdateDenorm$)) {
		if (!update) continue
		yield tracked(update.seqId.toString(), update)
	}
}

export async function* watchUpdates() {
	const updateDenorm = await getQueueUpdateDenorm({ seqId: 0, queue: queue, nowPlaying })
	yield tracked(updateDenorm.seqId.toString(), updateDenorm)

	for await (const update of toAsyncGenerator(queueUpdateDenorm$)) {
		if (!update) continue
		yield tracked(update.seqId.toString(), updateDenorm)
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
	if (update.seqId + 1 !== queue.length) {
		return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
	}
	queue = update.queue
	seqId = update.seqId + 1
	queueUpdateSubject.next({ ...update, seqId })
	return { code: 'ok' as const }
}
