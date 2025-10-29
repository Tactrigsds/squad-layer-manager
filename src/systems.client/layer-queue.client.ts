import { fromOrpcSubscription } from '@/lib/async'
import * as L from '@/models/layer'
import * as SS from '@/models/server-state.models'
import * as PartSys from '@/systems.client/parts'
import { orpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

const unexpectedNextLayerCold$ = fromOrpcSubscription(() => orpc.layerQueue.watchUnexpectedNextLayer())

export const [useUnexpectedNextLayer, unexpectedNextLayer$] = ReactRx.bind<L.LayerId | null>(
	unexpectedNextLayerCold$,
	null,
)
