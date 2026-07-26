import type { AsyncResource } from '@/lib/async-resource'
import type RconCore from '@/lib/rcon/core-rcon'
import type * as Rx from '@/lib/rxjs'
import type * as CS from '@/models/context-shared'
import type * as SS from '@/models/server-state.models'
import type * as SM from '@/models/squad.models'

export type Ctx = CS.Ctx & { squadRcon: Ctx.Payload } & Ctx.Rcon & SS.Ctx

export namespace Ctx {
	// a live rcon connection, without any of the per-server resources built on top of it
	export type Rcon = CS.Ctx & {
		rcon: RconCore
	}

	export type Payload = {
		rconEvent$: Rx.Observable<[CS.Otel, SM.RconEvents.Event]>

		layersStatus: AsyncResource<SM.LayerStatusRes, Ctx.Rcon & CS.AbortSignal>
		serverInfo: AsyncResource<SM.ServerInfoRes, Ctx.Rcon & CS.AbortSignal>
		// serverId: the roster is annotated with admin status, which is a per-server question (which admin lists apply)
		teams: AsyncResource<SM.TeamsRes, Ctx.Rcon & SS.Ctx & CS.AbortSignal>
	}
}

export type WarnOptionsBase = { msg: string | string[] } | string | string[]
// returning undefined indicates warning should be skipped
export type WarnOptions = WarnOptionsBase | ((ctx: SM.Ctx) => WarnOptionsBase | undefined)
