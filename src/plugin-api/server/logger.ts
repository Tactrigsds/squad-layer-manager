/**
 * A plugin's logger is `ctx.log`, and its telemetry scope is `ctx.module` -- both named `plugin:<id>`
 * by the host, which is what separates a plugin's logs, spans and metrics from core's. Nothing here
 * lets a plugin name itself; `childModule` only narrows the scope it was given.
 */
import type { OtelModule } from '@/lib/otel'

export function childModule(module: OtelModule, submoduleName: string): OtelModule {
	return module.child(submoduleName)
}
export type { OtelModule } from '@/lib/otel'
