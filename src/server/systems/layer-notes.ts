import { layerNotes } from '$root/drizzle/schema.ts'
import * as Messages from '@/messages.ts'
import * as CS from '@/models/context-shared.ts'
import * as LL from '@/models/layer-list.models.ts'
import * as NOTE from '@/models/layer-notes.models.ts'
import * as L from '@/models/layer.ts'
import * as USR from '@/models/users.models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as SquadServer from '@/server/systems/squad-server.ts'
import * as Rx from 'rxjs'
import * as TrpcServer from '../trpc.server.ts'

type LayerNoteState = {
	reviewingLayer: L.LayerId | null
	currentReviewSub: Rx.Subscription | null
}

const noteMutation$ = new Rx.Subject<USR.UserEntityMutation<NOTE.LayerNote['id'], NOTE.LayerNote>>()
const reviewingLayerUpdate$ = new Rx.Subject<LayerNoteState['reviewingLayer']>()

let state = {
	currentReviewingLayer: null,
	currentReviewSub: null,
}

export async function requestLayerFeedback(ctx: CS.Log & C.Db & C.User, layerId: L.LayerId) {
	const serverState = await LayerQueue.getServerState(ctx)
	let index: LL.LLItemIndex | undefined
	if (serverState.layerQueue.length === 0) return { code: 'err:empty' as const }
	state.currentReviewingLayer = layerId
	state.currentReviewSub = Rx.of(0).pipe(Rx.delay(CONFIG.layerNotes.feedbackDuration)).subscribe(() => {
		state.currentReviewingLayer = null
		state.currentReviewSub = null
	})

	await SquadServer.warnAllAdmins(ctx, Messages.WARNS.queue.requestFeedback(ctx.user.username, layerId))
	return { code: 'ok' as const }
}

export async function createNote(ctx: CS.Log & C.Db & C.User) {
}

export const router = TrpcServer.router({})
