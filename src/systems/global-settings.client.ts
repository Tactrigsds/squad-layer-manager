import type * as GS from '@/models/global-settings.models'
import * as RPC from '@/orpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

export const [useGlobalSettings, globalSettings$] = ReactRx.bind(
	RPC.observe(() => RPC.orpc.globalSettings.watchSettings.call()).pipe(
		Rx.filter((value): value is GS.GlobalSettings => !('code' in value)),
	),
)
