import type * as L from '@/models/layer'
import * as RPC from '@/orpc.client'
import * as ReactRx from '@react-rxjs/core'

const unexpectedNextLayerCold$ = RPC.observe(() => RPC.orpc.layerQueue.watchUnexpectedNextLayer.call())

export const [useUnexpectedNextLayer, unexpectedNextLayer$] = ReactRx.bind<L.LayerId | null>(
	unexpectedNextLayerCold$,
	null,
)
