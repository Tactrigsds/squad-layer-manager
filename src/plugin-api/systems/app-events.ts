import * as AppEvents from '@/models/app-events.models'
import * as MatchHistory from '@/systems/match-history.server'
import type * as PluginsSys from '@/systems/plugins.server'
import * as SquadServer from '@/systems/squad-server.server'

/**
 * Records a PLUGIN_EVENT in the audit log and this server's activity feed, attributed to the plugin.
 * `name` identifies the kind of event within the plugin, and is what a client-side renderer registers
 * against (see slm/plugin/events); `message` is the line admins read without one.
 *
 * This is the only way in. Writing a core event type would let a plugin forge a MATCH_ENDED, or a warn
 * it never sent.
 */
export async function emit(ctx: PluginsSys.ServerCtx<any>, name: string, payload: unknown, message: string) {
	await SquadServer.emitAppEvent(
		ctx,
		AppEvents.create<AppEvents.PluginEvent>({
			type: 'PLUGIN_EVENT',
			actor: { type: 'plugin', pluginId: ctx.plugin.id },
			serverId: ctx.serverId,
			// the feed replays by matchId, so an event without one is live-only: it disappears on reload
			matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
			causeId: null,
			pluginId: ctx.plugin.id,
			name,
			payload,
			message,
		}),
	)
}
