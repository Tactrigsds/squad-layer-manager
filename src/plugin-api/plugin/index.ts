// The plugin SDK's root entry: manifests, tables and the ctx types. The runtime pieces live under
// slm/plugin/* (config, servers, rpc.server, ...) and the reachable core surface under slm/lib|models|systems.
export { API_VERSION, definePlugin, defineTables } from '@/models/plugins.models'
export type { Config, ConfigInput, Manifest, PluginId, PluginMigration } from '@/models/plugins.models'
export type { Ctx, ServerCtx } from '@/systems/plugins.server'
