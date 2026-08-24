/**
 * A plugin's logger is `ctx.log`, and its telemetry scope is `ctx.module` -- both named `plugin:<id>`
 * by the host, which is what separates a plugin's logs, spans and metrics from core's. Nothing here
 * lets a plugin name itself; `childModule` only narrows the scope it was given.
 */
export { getChildModule as childModule } from '@/lib/otel'
export type { OtelModule } from '@/lib/otel'
