import { anySignal } from '@/lib/async'
import { getChildModule, type OtelModule } from '@/lib/otel.ts'
import * as ATTRS from '@/models/otel-attrs'
import * as Otel from '@opentelemetry/api'
import { os } from '@orpc/server'
import type Pino from 'pino'
import * as C from './context.ts'

type OrpcMeta = { logLevel?: Pino.Level; type?: 'query' | 'mutation' }

export const getOrpcBase = (module: OtelModule) => {
	const submodule = getChildModule(module, 'orpc')
	const spanOpMiddleware = os.$context<C.OrpcBase>().$meta<OrpcMeta>({}).middleware((opts) => {
		type Opts = typeof opts
		const meta = opts.procedure['~orpc'].meta
		const eventLevel = meta?.logLevel ?? (meta?.type === 'mutation' ? 'info' : 'debug')
		return C.spanOp(
			opts.path[opts.path.length - 1],
			{
				module: submodule,
				kind: Otel.SpanKind.SERVER,
				levels: { error: 'error', event: eventLevel },
				attrs: (ctx, o) => ({ [ATTRS.Orpc.PATH]: o.path.join('/') }),
			},
			async (ctx: Opts['context'], opts: Opts) => {
				// narrow the connection-level signal to also abort with this particular call
				return opts.next({ context: { ...ctx, signal: anySignal(ctx.signal, opts.signal)! } })
			},
		)(opts.context, opts)
	})

	return os.$context<C.OrpcBase>().$meta<OrpcMeta>({}).use(spanOpMiddleware)
}
