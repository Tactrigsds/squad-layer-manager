/**
 * SLM's settings: the global settings and each server's settings. The readers return live objects: read them, do not
 * mutate them. Change them through the update functions, which validate a write as the settings pages do and record
 * it as a SETTINGS_UPDATED naming the plugin.
 *
 * A server's settings here are what every signed-in client sees of them, without the connection details.
 */
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import * as SETTINGS from '@/models/settings.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Settings from '@/systems/settings.server'
import * as SquadServer from '@/systems/squad-server.server'

export function global(): Readonly<SETTINGS.GlobalSettings> {
	return Settings.GLOBAL_SETTINGS
}

/** Undefined when the server is not running: it is disabled, its settings are broken, or it does not exist. */
export function server(serverId: string): Readonly<SETTINGS.PublicServerSettings> | undefined {
	return SquadServer.find(serverId)?.serverSettings.settings
}

/** The global settings each time they change. Does not emit the current value. */
export function globalChanges(ctx: PluginsSys.Ctx<any>): Rx.Observable<Readonly<SETTINGS.GlobalSettings>> {
	return Settings.settings$.pipe(
		Rx.filter((event) => event.scope === 'global'),
		Rx.map(() => Settings.GLOBAL_SETTINGS),
		Rx.Ext.withAbortSignal(ctx.signal),
	)
}

/** A server's settings each time they change. Does not emit the current value. */
export function serverChanges(ctx: PluginsSys.Ctx<any>, serverId: string): Rx.Observable<Readonly<SETTINGS.PublicServerSettings>> {
	return Settings.settings$.pipe(
		Rx.filter(
			(event): event is Extract<Settings.SettingsEvent, { scope: 'server' }> => event.scope === 'server' && event.serverId === serverId,
		),
		Rx.map((event) => SETTINGS.getPublicSettings(event.settings)),
		// a change to the connection details alone changes nothing visible here
		Rx.distinctUntilChanged(Obj.deepEqual),
		Rx.Ext.withAbortSignal(ctx.signal),
	)
}

export type Mutation = SETTINGS.SettingMutation

export type UpdateResult =
	| { code: 'ok' }
	| { code: 'err:invalid-settings'; message: string }
	| { code: 'err:unknown-repeat-ruleset'; message: string }
	| { code: 'err:invalid-path'; message: string }

/** Sets each `{ path, value }` in the global settings, all or nothing. A `value` of undefined removes the key. */
export async function updateGlobal(ctx: PluginsSys.Ctx<any>, ops: Mutation[]): Promise<UpdateResult> {
	const invalid = invalidPath(ops)
	if (invalid) return invalid
	return await Settings.editGlobalSettings(ctx, ops, { type: 'plugin', pluginId: ctx.plugin.id })
}

/** `updateGlobal` for a server's settings, whether or not it is running. The connection details cannot be written. */
export async function updateServer(
	ctx: PluginsSys.Ctx<any>,
	serverId: string,
	ops: Mutation[],
): Promise<UpdateResult | { code: 'err:server-not-found' }> {
	if (!Settings.hasServerEntry(serverId)) return { code: 'err:server-not-found' }
	const invalid = invalidPath(ops)
	if (invalid) return invalid
	const connection = ops.find((op) => op.path[0] === 'connections')
	if (connection) return { code: 'err:invalid-path', message: 'Connection settings cannot be written by a plugin' }
	return await Settings.editServerSettings(
		{ ...ctx, serverId },
		ops,
		{ type: 'plugin', pluginId: ctx.plugin.id },
		{ type: 'plugin', event: 'edit-settings', pluginId: ctx.plugin.id },
	)
}

function invalidPath(ops: Mutation[]): Extract<UpdateResult, { code: 'err:invalid-path' }> | undefined {
	const op = ops.find(
		(op) => op.path.length === 0 || op.path.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype'),
	)
	if (op) return { code: 'err:invalid-path', message: `Invalid settings path "${op.path.join('.')}"` }
}
