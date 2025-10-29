import { coldOrpcSubscription } from '@/lib/async'
import * as L from '@/models/layer'
import * as SS from '@/models/server-state.models'
import * as RPC from '@/orpc.client'
import * as PartSys from '@/systems.client/parts'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

const unexpectedNextLayerCold$ = coldOrpcSubscription(() => RPC.orpc.layerQueue.watchUnexpectedNextLayer.call())

export const [useUnexpectedNextLayer, unexpectedNextLayer$] = ReactRx.bind<L.LayerId | null>(
	unexpectedNextLayerCold$,
	null,
)
