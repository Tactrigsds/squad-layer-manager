import * as Obj from '@/lib/object-utils'
/**
 * The repeat rulesets admins pick for servers and rotations, and the same writes the settings pages make. A write
 * lands the way an admin's does: every open page updates, and SETTINGS_UPDATED records it against the plugin.
 */
import * as Rx from '@/lib/rxjs'
import * as RRS from '@/models/repeat-rulesets.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Settings from '@/systems/settings.server'

/** Every repeat ruleset. Live objects: read them, do not mutate them. */
export function list(): readonly RRS.Ruleset[] {
	return Settings.GLOBAL_SETTINGS.repeatRulesets
}

export function get(id: RRS.RulesetId): RRS.Ruleset | undefined {
	return RRS.find(Settings.GLOBAL_SETTINGS.repeatRulesets, id)
}

/** The ruleset the plugin's server applies, or undefined when it applies none. */
export function forServer(ctx: PluginsSys.ServerCtx<any>): RRS.Ruleset | undefined {
	return get(Settings.getServerEntry(ctx.serverId)?.repeatRulesetId ?? '')
}

/** Points the plugin's server at another ruleset. Takes effect for the queue's warnings and layer generation at once. */
export async function setForServer(
	ctx: PluginsSys.ServerCtx<any>,
	id: RRS.RulesetId,
): Promise<{ code: 'ok' } | { code: 'err:unknown-repeat-ruleset'; message: string }> {
	return await Settings.setServerRepeatRuleset(ctx, id, ctx.plugin.id)
}

/**
 * Creates a ruleset, or replaces the one with the same id. A ruleset made for a server when it was created stays that
 * server's, whatever `ownerServerId` the input carries.
 */
export async function save(
	ctx: PluginsSys.Ctx<any>,
	ruleset: RRS.Ruleset,
): Promise<{ code: 'ok'; ruleset: RRS.Ruleset } | { code: 'err:invalid-settings'; message: string }> {
	return await Settings.saveRepeatRuleset(ctx, RRS.RulesetSchema.parse(ruleset), { type: 'plugin', pluginId: ctx.plugin.id })
}

/** Refuses a ruleset that a server or rotation still uses. */
export async function remove(
	ctx: PluginsSys.Ctx<any>,
	id: RRS.RulesetId,
): Promise<
	| { code: 'ok' }
	| { code: 'err:not-found' }
	| { code: 'err:repeat-ruleset-in-use'; message: string }
	| { code: 'err:invalid-settings'; message: string }
> {
	return await Settings.deleteRepeatRuleset(ctx, id, { type: 'plugin', pluginId: ctx.plugin.id })
}

/** The rulesets after each change to them, whoever made it. Ends with the ctx. */
export function changes(ctx: PluginsSys.Ctx<any>): Rx.Observable<readonly RRS.Ruleset[]> {
	return Settings.settings$.pipe(
		Rx.filter((event) => event.scope === 'global'),
		Rx.map(() => Settings.GLOBAL_SETTINGS.repeatRulesets),
		Rx.startWith(Settings.GLOBAL_SETTINGS.repeatRulesets),
		Rx.distinctUntilChanged(Obj.deepEqual),
		Rx.skip(1),
		Rx.Ext.withAbortSignal(ctx.signal),
	)
}
