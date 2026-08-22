import type { z } from 'zod'

import type * as Rx from '@/lib/rxjs'
import type * as PLG from '@/models/plugins.models'
import * as PluginsSys from '@/systems/plugins.server'

// A per-server watch stream, mirroring core watch procedures: the observable is wrapped in an async
// generator bound to the call's abort signal, and re-projects while the managed server is loaded.
// The client reaches it via Rpc.queryStore (slm/plugin/rpc.client) with the same name.
export function stream<M extends PLG.Manifest<any>, I extends z.ZodType>(
	ctx: PluginsSys.Ctx<M>,
	name: string,
	input: I,
	project: (ctx: PluginsSys.ServerCtx<M>, input: z.infer<I>) => Rx.Observable<unknown>,
) {
	PluginsSys.registerRpc(ctx, name, { kind: 'stream', input, project: project as any })
}

// a one-shot call with a plugin-scoped (not per-server) ctx
export function handle<M extends PLG.Manifest<any>, I extends z.ZodType>(
	ctx: PluginsSys.Ctx<M>,
	name: string,
	input: I,
	handler: (ctx: PluginsSys.Ctx<M>, input: z.infer<I>) => Promise<unknown>,
) {
	PluginsSys.registerRpc(ctx, name, { kind: 'call', input, handler: handler as any })
}
