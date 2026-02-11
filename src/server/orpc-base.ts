import { getChildModule, type OtelModule } from '@/lib/otel.ts'
import { os } from '@orpc/server'
import * as C from './context.ts'

export const getOrpcBase = (module: OtelModule) => {
	const submodule = getChildModule(module, 'orpc')
	const spanOpMiddleware = os.$context<C.OrpcBase>().middleware((opts) => {
		type Opts = typeof opts
		return C.spanOp(
			opts.path[opts.path.length - 1],
			{ module: submodule, levels: { error: 'error' }, attrs: (ctx, o) => ({ path: o.path.join('/') }) },
			async (ctx: Opts['context'], opts: Opts) => {
				return opts.next({ context: ctx })
			},
		)(opts.context, opts)
	})

	return os.$context<C.OrpcBase>().use(spanOpMiddleware)
}
