// persistAppEvent writes a global audit-only event; emit is the per-server form, which also lands
// in that server's activity feed
export { persistAppEvent } from '@/systems/app-events.server'

import * as AppEvents from '@/models/app-events.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as SquadServer from '@/systems/squad-server.server'

// records a PLUGIN_EVENT in the audit log and this server's activity feed, attributed to the plugin
export async function emit(ctx: PluginsSys.ServerCtx<any>, name: string, payload: unknown, message: string) {
	await SquadServer.emitAppEvent(
		ctx,
		AppEvents.create<AppEvents.PluginEvent>({
			type: 'PLUGIN_EVENT',
			actor: { type: 'plugin', pluginId: ctx.plugin.id },
			serverId: ctx.serverId,
			matchId: null,
			causeId: null,
			pluginId: ctx.plugin.id,
			name,
			payload,
			message,
		}),
	)
}
