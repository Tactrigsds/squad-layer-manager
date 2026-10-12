import * as Color from '@/lib/color'
import { createId } from '@/lib/id'
import { z } from '@/lib/zod'
import * as LNote from '@/models/layer-notes.models'
import { t } from '@/models/messages.models'
import * as SDoc from '@/models/schema-docs.models'
import * as USR from '@/models/users.models'

// A tag's identity is its id, which is immutable and carries the label it was created with, so a tag whose definition has
// been deleted still renders as something a human recognizes. label/description/color are all freely editable.
//
// A `from-rotation:<rotationId>` id is the exception: it names no configured tag. SLM puts it on every item added to a
// queue from a saved rotation, and it renders as the rotation's current name.

export const ID_SUFFIX_LENGTH = 6
export const MAX_LABEL_LENGTH = 32
// a description says the same kind of thing a note does, at the same length
export const MAX_DESCRIPTION_LENGTH = LNote.MAX_LENGTH

export const FROM_ROTATION_LABEL = 'from-rotation'
const FROM_ROTATION_PREFIX = `${FROM_ROTATION_LABEL}:`
const FROM_ROTATION_ID = /^from-rotation:[a-z0-9_-]{1,64}$/
const CONFIGURED_TAG_ID = new RegExp(`^[^:\\n]{1,${MAX_LABEL_LENGTH}}:[A-Za-z0-9_-]{${ID_SUFFIX_LENGTH}}$`)
// the theme's primary colour, which marks what came from a rotation
export const FROM_ROTATION_COLOR = '#e0983a'

export const LabelSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_LABEL_LENGTH)
	.regex(/^[^:\n]+$/, {
		error: 'Label cannot contain ":" or a newline',
	})
	.refine((label) => label.toLowerCase() !== FROM_ROTATION_LABEL, { error: `"${FROM_ROTATION_LABEL}" is reserved` })

export const TagIdSchema = z.string().refine((id) => CONFIGURED_TAG_ID.test(id) || FROM_ROTATION_ID.test(id), {
	error: 'Malformed tag id',
})
export type TagId = z.infer<typeof TagIdSchema>

export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Must be a hex color like #7dd3fc' })

export const TagSchema = z.object({
	id: TagIdSchema.meta(SDoc.of({ label: t('ID') })),
	label: LabelSchema.meta(SDoc.of({ label: t('Label') })),
	description: z
		.string()
		.trim()
		.max(MAX_DESCRIPTION_LENGTH)
		.prefault('')
		.meta(SDoc.of({ label: t('Description') })),
	color: ColorSchema.meta(SDoc.of({ label: t('Color') })),
	preventSwaps: z
		.boolean()
		.optional()
		.meta(
			SDoc.of({
				label: t('Prevent swaps'),
				description: t('Fixing repeats keeps the teams of a layer with this tag as they are, and only moves the layer.'),
			}),
		),
})
export type Tag = z.infer<typeof TagSchema>

export const TagsSchema = z
	.array(TagSchema)
	.prefault([])
	.meta(
		SDoc.of({
			description: t(
				'Tags that can be attached to layers in the queue. A tag is identified by an immutable id containing the label it was created with; renaming a tag therefore keeps it attached to every layer carrying it. Deleting a tag here does not strip it from layers already carrying it -- those fall back to displaying the raw tag id and can only be removed.',
			),
		}),
	)

export const AttributionSchema = z.record(TagIdSchema, USR.UserIdSchema)
export type Attribution = z.infer<typeof AttributionSchema>

// rebuilds attribution to match `tags`: whoever already claimed a tag keeps it, ids added in this change go to
// `setBy`, and ids no longer on the item are dropped so the two fields can't drift. Returns undefined when nothing is
// attributed, since a tag set by anything other than a user has nobody to show.
export function attribute(current: Attribution | undefined, tags: TagId[], setBy?: USR.UserId): Attribution | undefined {
	const next: Attribution = {}
	for (const id of tags) {
		const attributed = current?.[id] ?? setBy
		if (attributed !== undefined) next[id] = attributed
	}
	return Object.keys(next).length > 0 ? next : undefined
}

export function createTagId(label: string) {
	return `${label.trim()}:${createId(ID_SUFFIX_LENGTH)}`
}

// the label a tag was created with, recovered from its id. Used to render tags whose definition no longer exists.
export function originalLabel(id: TagId) {
	return id.slice(0, id.lastIndexOf(':'))
}

export function fromRotationTagId(rotationId: string): TagId {
	return `${FROM_ROTATION_PREFIX}${rotationId}`
}

export function rotationIdOfTag(id: TagId): string | undefined {
	return FROM_ROTATION_ID.test(id) ? id.slice(FROM_ROTATION_PREFIX.length) : undefined
}

// rotationId is set on a from-rotation tag; deleted then means the rotation no longer exists
export type Resolved = { id: TagId; label: string; description: string; color: string; deleted: boolean; rotationId?: string }

export function resolve(id: TagId, tags: Tag[], rotationName?: (rotationId: string) => string | undefined): Resolved {
	const rotationId = rotationIdOfTag(id)
	if (rotationId !== undefined) {
		const name = rotationName?.(rotationId)
		return { id, label: name ?? rotationId, description: '', color: FROM_ROTATION_COLOR, deleted: name === undefined, rotationId }
	}
	const tag = tags.find((t) => t.id === id)
	if (tag) return { ...tag, deleted: false }
	return { id, label: id, description: '', color: DELETED_TAG_COLOR, deleted: true }
}

export function resolveAll(ids: TagId[] | undefined, tags: Tag[], rotationName?: (rotationId: string) => string | undefined): Resolved[] {
	if (!ids) return []
	return ids.map((id) => resolve(id, tags, rotationName))
}

export const DELETED_TAG_COLOR = '#94a3b8'

export function suggestColor(existing: Tag[]) {
	return Color.pickDistinct(existing.map((t) => t.color))
}

export function labelConflict(tags: Tag[], label: string, ignoreId?: TagId) {
	const normalized = label.trim().toLowerCase()
	return tags.some((t) => t.id !== ignoreId && t.label.trim().toLowerCase() === normalized)
}
