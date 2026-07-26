import type { AsyncResource } from '@/lib/async-resource'
import * as CD from '@/lib/ctx-def'
import type RconCore from '@/lib/rcon/core-rcon'
import type * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared'
import type * as SM from '@/models/squad.models'

export type Ctx = CS.Ctx & { squadRcon: Ctx.Payload } & Ctx.Rcon & CS.ServerId
export namespace Ctx {
	// a live rcon connection, without any of the per-server resources built on top of it
	export type Rcon = CS.Ctx & {
		rcon: RconCore
	}
	export const RconDef = CD.defCtx<Rcon>()(['rcon'], { name: 'rcon' })

	export type Payload = {
		rconEvent$: Rx.Observable<[CS.Otel, SM.RconEvents.Event]>

		layersStatus: AsyncResource<SM.LayerStatusRes, Ctx.Rcon & CS.AbortSignal>
		serverInfo: AsyncResource<SM.ServerInfoRes, Ctx.Rcon & CS.AbortSignal>
		// serverId: the roster is annotated with admin status, which is a per-server question (which admin lists apply)
		teams: AsyncResource<SM.TeamsRes, Ctx.Rcon & CS.ServerId & CS.AbortSignal>
	}
}

export type WarnOptionsBase = { msg: string | string[] } | string | string[]
// returning undefined indicates warning should be skipped
export type WarnOptions = WarnOptionsBase | ((ctx: SM.Ctx) => WarnOptionsBase | undefined)

// after the namespace, not beside the type: a namespace compiles to an IIFE, so Ctx.RconDef does not
// exist until that block has run. Types do not care about order, defs are values and do.
export const CtxDef = CD.defCtx<Ctx>()(['squadRcon'], { name: 'squadRcon', extends: [Ctx.RconDef, CS.ServerIdDef] })
