import * as Rx from '@/lib/rxjs'
import type * as AppEvents from '@/models/app-events.models'
import * as F from '@/models/filter.models'
import * as RBAC from '@/rbac.models'
import * as FilterEntity from '@/systems/filter-entity.server'
import type * as PluginsSys from '@/systems/plugins.server'

/**
 * The filters admins see in the filter index, and the same writes the web client makes. A write here
 * lands the way an admin's does: open editors update, the reference index rebuilds, and FILTER_CHANGED
 * records it against the plugin rather than a person.
 *
 * A filter `create` makes is owned by the calling plugin, unless it names an admin as the owner. Only
 * admins with filters:write-all, and the filter's contributors, can edit a plugin's filter by hand. A plugin can read
 * and change any filter's contributors.
 *
 * Owning a filter does not lock it: a plugin can write any filter, and an admin can edit one a plugin
 * owns. Deactivating a plugin leaves its filters in place -- a pool config naming one that vanished
 * fails every layer-status query for that server. Clean up in the plugin's own deactivate if that is
 * wrong for yours.
 */

/** Every filter, newest state. Live objects: read them, do not mutate them. */
export function list(): F.FilterEntity[] {
	return Array.from(FilterEntity.state.filters.values())
}

export function get(id: F.FilterEntityId): F.FilterEntity | undefined {
	return FilterEntity.state.filters.get(id)
}

/**
 * Without `owner`, the calling plugin owns the filter. Without `missExemption`, seeding and training layers never
 * show the filter's miss indicator.
 */
export type NewFilter = Omit<F.FilterEntity, 'owner' | 'missExemption'> & {
	owner?: { type: 'slm-user'; userId: bigint }
	missExemption?: F.FilterNode | null
}

export async function create(ctx: PluginsSys.Ctx<any>, filter: NewFilter) {
	// rebuilt rather than passed through, so a plugin cannot hand the filter to SLM or to another plugin
	const owner: F.FilterOwner = filter.owner
		? { type: 'slm-user', userId: filter.owner.userId }
		: { type: 'plugin', pluginId: ctx.plugin.id }
	return await FilterEntity.createFilter(
		ctx,
		F.FilterEntitySchema.parse({
			...filter,
			missExemption: filter.missExemption === undefined ? F.DEFAULT_MISS_EXEMPTION : filter.missExemption,
			owner,
		}),
		actorFor(ctx),
	)
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

/** The users and roles that can edit the filter without owning it. Empty for a filter that does not exist. */
export async function getContributors(ctx: PluginsSys.Ctx<any>, id: F.FilterEntityId): Promise<RBAC.Contributor[]> {
	return await FilterEntity.listFilterContributors(ctx, id)
}

/** `err:unknown-user` means the user has never signed in to SLM. */
export async function addContributor(
	ctx: PluginsSys.Ctx<any>,
	id: F.FilterEntityId,
	contributor: RBAC.Contributor,
): Promise<{ code: 'ok' } | { code: 'err:not-found' } | { code: 'err:unknown-user' } | { code: 'err:already-exists' }> {
	return await FilterEntity.addFilterContributor(ctx, id, RBAC.ContributorSchema.parse(contributor), actorFor(ctx))
}

/** `err:not-found` means the filter does not exist, or does not have that contributor. */
export async function removeContributor(
	ctx: PluginsSys.Ctx<any>,
	id: F.FilterEntityId,
	contributor: RBAC.Contributor,
): Promise<{ code: 'ok' } | { code: 'err:not-found' }> {
	return await FilterEntity.removeFilterContributor(ctx, id, RBAC.ContributorSchema.parse(contributor), actorFor(ctx))
}

/**
 * Adds the source filter's contributors, users and roles, to the target filter. Contributors the target already has
 * are kept, so repeating a copy changes nothing.
 */
export async function copyContributors(
	ctx: PluginsSys.Ctx<any>,
	sourceId: F.FilterEntityId,
	targetId: F.FilterEntityId,
): Promise<{ code: 'ok' } | { code: 'err:not-found' }> {
	return await FilterEntity.copyFilterContributors(ctx, sourceId, targetId, actorFor(ctx))
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
