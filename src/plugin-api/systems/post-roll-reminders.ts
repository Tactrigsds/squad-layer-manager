import type * as PLG from '@/models/plugins.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Reminders from '@/systems/post-roll-reminders.server'

/**
 * Registers a provider asked, after each roll on `ctx`'s server, for the messages this plugin wants
 * warned to admins there. Call it from `Servers.setup`. Return the ones that apply right now: an empty
 * array says nothing, and several are fine, so no reminder has to outrank another. Withdrawing one is
 * returning it no longer.
 *
 * The host does the warning, paced with its own announcements, so a plugin never reaches the game
 * server on its own schedule. Errors are isolated: a provider that throws contributes nothing and
 * does not stop the others. Unregistered when the server goes down or the plugin stops.
 */
export function register<M extends PLG.Manifest<any>>(ctx: PluginsSys.ServerCtx<M>, provide: () => Promise<string[]>) {
	Reminders.register(ctx, provide)
}
