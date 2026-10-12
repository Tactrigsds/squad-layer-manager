import type * as LTag from '@/models/layer-tags.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Settings from '@/systems/settings.server'

/**
 * The tags admins configure in the global settings. Layer tags go on queue items, and rotation tags on rotations.
 * An item or a rotation names a tag by its id, so a tag keeps its place everywhere it is used when an admin renames it.
 *
 * To let an admin choose a rotation tag instead, declare the config field with `Fields.rotationTagId()`.
 */
export type Kind = 'layer' | 'rotation'

const KEYS = { layer: 'layerTags', rotation: 'rotationTags' } as const

export function list(kind: Kind): readonly LTag.Tag[] {
	return Settings.GLOBAL_SETTINGS[KEYS[kind]]
}

/**
 * The tag of this kind labeled `label`, matched without regard to case, or a new one with that label when there is
 * none. A label holds no ":" or newline. The settings change is recorded against the calling plugin.
 */
export async function ensure(
	ctx: PluginsSys.Ctx<any>,
	kind: Kind,
	label: string,
): Promise<
	{ code: 'ok'; tag: LTag.Tag } | { code: 'err:invalid-label'; message: string } | { code: 'err:invalid-settings'; message: string }
> {
	return await Settings.ensureTag(ctx, KEYS[kind], label, { type: 'plugin', pluginId: ctx.plugin.id })
}
