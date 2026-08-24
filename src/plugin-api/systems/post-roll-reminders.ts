import type * as PLG from '@/models/plugins.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Reminders from '@/systems/post-roll-reminders.server'

/**
 * Registers a provider asked, after each roll, for the messages this plugin wants warned to admins on
 * that server. Return the ones that apply right now: an empty array says nothing, and several are
 * fine, so no reminder has to outrank another. Withdrawing one is returning it no longer.
 *
 * The host does the warning, paced with its own announcements, so a plugin never reaches the game
 * server on its own schedule. Errors are isolated: a provider that throws contributes nothing and
 * does not stop the others. Unregistered when the plugin stops.
 */
export function register<M extends PLG.Manifest<any>>(
	ctx: PluginsSys.Ctx<M>,
	provide: (ctx: PluginsSys.ServerCtx<M>) => Promise<string[]>,
) {
	Reminders.register(ctx.cleanup, (serverCtx) =>
		provide({
			...serverCtx,
			plugin: ctx.plugin,
			log: ctx.log.child({ serverId: serverCtx.serverId }),
			cleanup: ctx.cleanup,
			module: ctx.module,
		} as PluginsSys.ServerCtx<M>),
	)
}
