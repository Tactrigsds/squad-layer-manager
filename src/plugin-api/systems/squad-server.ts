/**
 * The managed server itself: its live event stream, and ending a match.
 *
 * `endMatch` is here rather than on slm/systems/squad-rcon because a bare rcon end produces an
 * unattributed round end. The host emits the MATCH_ENDED and arms the expectation for it, which is also
 * why a plugin cannot assemble this itself: slm/systems/app-events only writes PLUGIN_EVENT.
 */
import * as Rx from '@/lib/rxjs'
import type * as CS from '@/models/context-shared'
import type * as SE from '@/models/server-events.models'
import type * as SQS from '@/models/squad-server.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as SquadServer from '@/systems/squad-server.server'

/** Ends the current match, attributed to the calling plugin, and waits for the round end it produces. */
export async function endMatch(ctx: PluginsSys.ServerCtx<any>) {
	return await SquadServer.endMatchAction(ctx, { type: 'plugin', pluginId: ctx.plugin.id })
}

/**
 * Every server event as it lands: connects, chat, squad changes, kills, round ends. Hot and unbuffered,
 * so a subscriber sees only what happens after it subscribes. Wrap it in `durableSub`.
 */
export function events$(ctx: SQS.Ctx & CS.ServerId): Rx.Observable<SE.Event> {
	return ctx.server.event$.pipe(Rx.map(([_otel, event]) => event))
}

export { getCurrTeams } from '@/systems/squad-server.server'
