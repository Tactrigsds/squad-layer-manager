import { createId } from '@/lib/id'
import { z } from 'zod'

// A tag's identity is its id, which is immutable and carries the label it was created with, so a tag whose definition has
// been deleted still renders as something a human recognizes. label/description/color are all freely editable.

export const ID_SUFFIX_LENGTH = 6
export const MAX_LABEL_LENGTH = 32
export const MAX_DESCRIPTION_LENGTH = 300

export const LabelSchema = z.string().trim().min(1).max(MAX_LABEL_LENGTH).regex(/^[^:\n]+$/, {
	error: 'Label cannot contain ":" or a newline',
})

export const TagIdSchema = z.string().regex(new RegExp(`^[^:\\n]{1,${MAX_LABEL_LENGTH}}:[A-Za-z0-9_-]{${ID_SUFFIX_LENGTH}}$`), {
	error: 'Malformed tag id',
})
export type TagId = z.infer<typeof TagIdSchema>

export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Must be a hex color like #7dd3fc' })

export const TagSchema = z.object({
	id: TagIdSchema,
	label: LabelSchema,
	description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).prefault(''),
	color: ColorSchema,
})
export type Tag = z.infer<typeof TagSchema>

export const TagsSchema = z.array(TagSchema).prefault([]).describe(
	'Tags that can be attached to layers in the queue. A tag is identified by an immutable id containing the label it was created with; '
		+ 'renaming a tag therefore keeps it attached to every layer carrying it. Deleting a tag here does not strip it from layers already '
		+ 'carrying it -- those fall back to displaying the raw tag id and can only be removed.',
)

export function createTagId(label: string) {
	return `${label.trim()}:${createId(ID_SUFFIX_LENGTH)}`
}

// the label a tag was created with, recovered from its id. Used to render tags whose definition no longer exists.
export function originalLabel(id: TagId) {
	return id.slice(0, id.lastIndexOf(':'))
}

export type Resolved = { id: TagId; label: string; description: string; color: string; deleted: boolean }

export function resolve(id: TagId, tags: Tag[]): Resolved {
	const tag = tags.find(t => t.id === id)
	if (tag) return { ...tag, deleted: false }
	return { id, label: id, description: '', color: DELETED_TAG_COLOR, deleted: true }
}

export function resolveAll(ids: TagId[] | undefined, tags: Tag[]): Resolved[] {
	if (!ids) return []
	return ids.map(id => resolve(id, tags))
}

export const DELETED_TAG_COLOR = '#94a3b8'

// picked to stay legible against both the light and dark app backgrounds
const PALETTE = [
	'#ef4444',
	'#f97316',
	'#eab308',
	'#84cc16',
	'#22c55e',
	'#14b8a6',
	'#06b6d4',
	'#3b82f6',
	'#6366f1',
	'#a855f7',
	'#ec4899',
	'#f43f5e',
]

export function suggestColor(existing: Tag[]) {
	const used = new Set(existing.map(t => t.color.toLowerCase()))
	const free = PALETTE.filter(c => !used.has(c))
	if (free.length > 0) return free[Math.floor(Math.random() * free.length)]
	return hslToHex(Math.floor(Math.random() * 360), 65, 55)
}

function hslToHex(h: number, s: number, l: number) {
	const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
	const channel = (n: number) => {
		const k = (n + h / 30) % 12
		const value = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
		return Math.round(255 * value).toString(16).padStart(2, '0')
	}
	return `#${channel(0)}${channel(8)}${channel(4)}`
}

export function labelConflict(tags: Tag[], label: string, ignoreId?: TagId) {
	const normalized = label.trim().toLowerCase()
	return tags.some(t => t.id !== ignoreId && t.label.trim().toLowerCase() === normalized)
}
