import * as Rx from '@/lib/rxjs'
import type * as AppEvents from '@/models/app-events.models'
import * as LL from '@/models/layer-list.models'
import type * as LTag from '@/models/layer-tags.models'
import * as ROT from '@/models/rotations.models'
import type * as SLL from '@/models/shared-layer-list.models'
import * as RBAC from '@/rbac.models'
import * as LayerQueue from '@/systems/layer-queue.server'
import type * as PluginsSys from '@/systems/plugins.server'
import * as RotationEdit from '@/systems/rotation-edit.server'
import * as Rotation from '@/systems/rotation.server'
import * as Settings from '@/systems/settings.server'

/**
 * The rotations admins see on the rotations page, and the same writes the web client makes. A write here lands the
 * way an admin's does: every open page updates, and ROTATION_CHANGED records it against the plugin rather than a
 * person. Items are stored anonymized (see slm/models/rotation).
 *
 * A rotation `create` or `clone` makes is owned by the calling plugin, unless it names an admin as the owner. Only
 * admins with rotations:write-all, and the rotation's contributors, can edit a plugin's rotation by hand.
 *
 * Owning a rotation does not lock it: a plugin can write any rotation, and an admin can edit one a plugin owns.
 * Deactivating a plugin leaves its rotations in place.
 */

/**
 * One page of rotations, without their items, as the rotations page lists them. `q` matches the name and the
 * description, and `author` takes an owner key such as `plugin:<id>` or `user:<discordId>`. Archived rotations are
 * left out unless `archived` is set. Pass the page's `nextCursor` back as `cursor` for the next page; it is null on the
 * last page.
 */
export async function search(ctx: PluginsSys.Ctx<any>, input: ROT.SearchInput = {}): Promise<ROT.SearchPage> {
	return await Rotation.searchSummaries(ctx, ROT.SearchInputSchema.parse(input))
}

export async function get(ctx: PluginsSys.Ctx<any>, id: ROT.RotationId): Promise<ROT.Rotation | undefined> {
	return await Rotation.getRotation(ctx, id)
}

/** A refusal any write that sets a repeat ruleset or tags can return. */
export type InvalidMetaError = { code: 'err:unknown-repeat-ruleset'; message: string } | { code: 'err:unknown-tags'; message: string }

/** An item without an `itemId` or `source` is given one. */
export type NewItems = LL.NewItem[]

/** Without `owner`, the calling plugin owns the rotation. */
export type NewRotation = Omit<ROT.NewRotation, 'items'> & { items?: NewItems; owner?: { type: 'slm-user'; userId: bigint } }

export type CreateResult = { code: 'ok'; rotation: ROT.Rotation } | { code: 'err:already-exists' } | InvalidMetaError

export async function create(ctx: PluginsSys.Ctx<any>, rotation: NewRotation): Promise<CreateResult> {
	const { owner, items, ...rest } = rotation
	const input = ROT.NewRotationSchema.parse({ ...rest, items: items && toList(items) })
	return await Rotation.createRotation(ctx, { ...input, owner: ownerFor(ctx, owner) }, actorFor(ctx))
}

export type UpdatePatch = Omit<ROT.UpdatePatch, 'items'> & { items?: NewItems }

/**
 * Writes the fields `patch` names. Refuses new items with `err:unsaved-edits` while an admin has unsaved edits to the
 * rotation's items open, rather than discarding them. Try again later.
 */
export async function update(
	ctx: PluginsSys.Ctx<any>,
	id: ROT.RotationId,
	patch: UpdatePatch,
): Promise<
	| { code: 'ok'; rotation: ROT.Rotation }
	| { code: 'err:not-found' }
	| { code: 'err:unsaved-edits' }
	| { code: 'err:rejected'; reason: SLL.Rejection['code'] }
	| InvalidMetaError
> {
	const { items, ...meta } = patch
	const parsed = ROT.UpdatePatchSchema.parse({ ...meta, items: items && toList(items) })
	return await RotationEdit.updateOutsideDraft(ctx, id, parsed, actorFor(ctx), { type: 'plugin', pluginId: ctx.plugin.id })
}

export type CloneInput = {
	sourceId: ROT.RotationId
	id: ROT.RotationId
	name: string
	copyTags?: boolean
	/** Without it, the calling plugin owns the clone. */
	owner?: { type: 'slm-user'; userId: bigint }
}

/** Copies the source's items, description and repeat ruleset. Its contributors are not copied. */
export async function clone(ctx: PluginsSys.Ctx<any>, input: CloneInput): Promise<CreateResult | { code: 'err:not-found' }> {
	const parsed = ROT.CloneInputSchema.parse({ ...input, copyTags: input.copyTags ?? false, copyContributors: false })
	return await Rotation.cloneRotation(ctx, parsed, ownerFor(ctx, input.owner), actorFor(ctx))
}

/**
 * Adds the source rotation's contributors, users and roles, to the target rotation. Contributors the target already has
 * are kept, so repeating a copy changes nothing.
 */
export async function copyContributors(
	ctx: PluginsSys.Ctx<any>,
	sourceId: ROT.RotationId,
	targetId: ROT.RotationId,
): Promise<{ code: 'ok' } | { code: 'err:not-found' }> {
	return await Rotation.copyContributors(ctx, sourceId, targetId, actorFor(ctx))
}

/** The users and roles that can edit the rotation without owning it. Empty for a rotation that does not exist. */
export async function getContributors(ctx: PluginsSys.Ctx<any>, id: ROT.RotationId): Promise<RBAC.Contributor[]> {
	return await Rotation.listContributors(ctx, id)
}

/** `err:unknown-user` means the user has never signed in to SLM. */
export async function addContributor(
	ctx: PluginsSys.Ctx<any>,
	id: ROT.RotationId,
	contributor: RBAC.Contributor,
): Promise<{ code: 'ok' } | { code: 'err:not-found' } | { code: 'err:unknown-user' } | { code: 'err:already-exists' }> {
	return await Rotation.addContributor(ctx, id, RBAC.ContributorSchema.parse(contributor), actorFor(ctx))
}

/** `err:not-found` means the rotation does not exist, or does not have that contributor. */
export async function removeContributor(
	ctx: PluginsSys.Ctx<any>,
	id: ROT.RotationId,
	contributor: RBAC.Contributor,
): Promise<{ code: 'ok' } | { code: 'err:not-found' }> {
	return await Rotation.removeContributor(ctx, id, RBAC.ContributorSchema.parse(contributor), actorFor(ctx))
}

export async function remove(ctx: PluginsSys.Ctx<any>, id: ROT.RotationId): Promise<{ code: 'ok' } | { code: 'err:not-found' }> {
	const res = await Rotation.deleteRotation(ctx, id, actorFor(ctx))
	return { code: res.code }
}

/**
 * Adds a rotation's items to the server's saved queue, as Add Rotation does: in place of every queued item
 * (`replace`), ahead of them (`start`) or after them (`end`). The items are sourced to the calling plugin, carry the
 * rotation's `from-rotation:<id>` tag and any `tags` given, and their notes name the rotation.
 *
 * `clear` removes the queued items it accepts in the same edit, before `placement` is applied to what remains. To keep
 * only the training layers, for example, clear every item that is not one, and place the rotation at the `end`.
 *
 * Refuses with `err:unsaved-edits` while anyone has queue edits open, as layer-queue's editSaved does.
 */
export async function addToQueue(
	ctx: PluginsSys.ServerCtx<any>,
	id: ROT.RotationId,
	opts: { placement: LL.Placement; tags?: LTag.TagId[]; clear?: (item: LL.Item) => boolean },
): Promise<{ code: 'ok' } | { code: 'err:not-found' } | { code: 'err:unsaved-edits' } | { code: 'err:unknown-tags'; message: string }> {
	const rotation = await Rotation.getRotation(ctx, id)
	if (!rotation) return { code: 'err:not-found' }
	const tags = opts.tags ?? []
	const unknownTags = Settings.unknownLayerTags(tags)
	if (unknownTags.length > 0) return { code: 'err:unknown-tags', message: `Unknown layer tags: ${unknownTags.join(', ')}` }
	const source: LL.Source = { type: 'plugin', pluginId: ctx.plugin.id }
	const items = LL.withTags(ROT.toQueueItems(rotation, source), tags)
	// see layer-queue's editSaved: the runtime object is the whole managed server, which the save path needs
	return await LayerQueue.addToSaved(
		ctx as unknown as Parameters<typeof LayerQueue.addToSaved>[0],
		{ source, clear: opts.clear },
		items,
		opts.placement,
	)
}

export type RotationChange = { type: 'add' | 'update' | 'delete'; rotation: ROT.Rotation; actor: AppEvents.Actor }

/** Every write, this plugin's included. Ends with the ctx: the plugin stopping, or that server going down. */
export function changes(ctx: PluginsSys.Ctx<any>): Rx.Observable<RotationChange> {
	return Rotation.rotationMutation$.pipe(
		Rx.map(([, mutation]): RotationChange => ({ type: mutation.type, rotation: mutation.value, actor: mutation.actor })),
		Rx.Ext.withAbortSignal(ctx.signal),
	)
}

const UNKNOWN_SOURCE: LL.Source = { type: 'unknown' }

function toList(items: NewItems): LL.List {
	return LL.ListSchema.parse(
		items.map((item) => ({ ...item, itemId: item.itemId ?? LL.createItemId(), source: item.source ?? UNKNOWN_SOURCE })),
	)
}

// rebuilt rather than passed through, so a plugin cannot hand the rotation to SLM or to another plugin
function ownerFor(ctx: PluginsSys.Ctx<any>, owner: { type: 'slm-user'; userId: bigint } | undefined): ROT.Owner {
	return owner ? { type: 'slm-user', userId: owner.userId } : { type: 'plugin', pluginId: ctx.plugin.id }
}

function actorFor(ctx: PluginsSys.Ctx<any>): AppEvents.Actor {
	return { type: 'plugin', pluginId: ctx.plugin.id }
}
