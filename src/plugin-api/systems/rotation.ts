import * as Rx from '@/lib/rxjs'
import type * as AppEvents from '@/models/app-events.models'
import * as LL from '@/models/layer-list.models'
import * as ROT from '@/models/rotations.models'
import type * as SLL from '@/models/shared-layer-list.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as RotationEdit from '@/systems/rotation-edit.server'
import * as Rotation from '@/systems/rotation.server'

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

/** Every rotation, archived ones included. Live objects: read them, do not mutate them. */
export function list(): ROT.Rotation[] {
	return Array.from(Rotation.state.rotations.values())
}

export function get(id: ROT.RotationId): ROT.Rotation | undefined {
	return Rotation.state.rotations.get(id)
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

export async function remove(ctx: PluginsSys.Ctx<any>, id: ROT.RotationId): Promise<{ code: 'ok' } | { code: 'err:not-found' }> {
	const res = await Rotation.deleteRotation(ctx, id, actorFor(ctx))
	return { code: res.code }
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
