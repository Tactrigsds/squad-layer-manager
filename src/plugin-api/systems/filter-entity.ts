import * as Rx from '@/lib/rxjs'
import type * as AppEvents from '@/models/app-events.models'
import * as F from '@/models/filter.models'
import * as FilterEntity from '@/systems/filter-entity.server'
import type * as PluginsSys from '@/systems/plugins.server'

/**
 * The filters admins see in the filter index, and the same writes the web client makes. A write here
 * lands the way an admin's does: open editors update, the reference index rebuilds, and FILTER_CHANGED
 * records it against the plugin rather than a person.
 *
 * A filter belongs to a user, and a plugin is not one, so `create` asks for an owner: name the admin
 * who is answerable for the filter. They get the filter-owner role over it and can edit it by hand.
 *
 * A plugin can write any filter, not only ones it created. Nothing marks a filter as a plugin's, and
 * deactivating a plugin leaves its filters in place -- a pool config naming one that vanished fails
 * every layer-status query for that server. Clean up in the plugin's own deactivate if that is wrong
 * for yours.
 */

/** Every filter, newest state. Live objects: read them, do not mutate them. */
export function list(): F.FilterEntity[] {
	return Array.from(FilterEntity.state.filters.values())
}

export function get(id: F.FilterEntityId): F.FilterEntity | undefined {
	return FilterEntity.state.filters.get(id)
}

export async function create(ctx: PluginsSys.Ctx<any>, filter: F.FilterEntity) {
	return await FilterEntity.createFilter(ctx, F.FilterEntitySchema.parse(filter), actorFor(ctx))
}

export async function update(
	ctx: PluginsSys.Ctx<any>,
	id: F.FilterEntityId,
	update: Partial<F.FilterEntityUpdate>,
): Promise<{ code: 'ok'; filter: F.FilterEntity } | { code: 'err:not-found' } | { code: 'err:cyclical-reference'; cycle: string[] }> {
	const res = await FilterEntity.updateFilter(ctx, id, F.UpdateFilterEntitySchema.partial().parse(update), actorFor(ctx))
	// the host also hands back the pre-update filter, which only the app-event diff needs
	return res.code === 'ok' ? { code: 'ok', filter: res.filter } : res
}

/** Refuses to delete a filter anything still points at, and reports what those references are. */
export async function remove(ctx: PluginsSys.Ctx<any>, id: F.FilterEntityId) {
	return await FilterEntity.deleteFilter(ctx, id, actorFor(ctx))
}

export type FilterChange = { type: 'add' | 'update' | 'delete'; filter: F.FilterEntity }

/** Every write, this plugin's included. Ends with the ctx: the plugin stopping, or that server going down. */
export function changes(ctx: PluginsSys.Ctx<any>): Rx.Observable<FilterChange> {
	return FilterEntity.filterMutation$.pipe(
		Rx.map(([, mutation]): FilterChange => ({ type: mutation.type, filter: mutation.value })),
		Rx.Ext.withAbortSignal(ctx.signal),
	)
}

function actorFor(ctx: PluginsSys.Ctx<any>): AppEvents.Actor {
	return { type: 'plugin', pluginId: ctx.plugin.id }
}
