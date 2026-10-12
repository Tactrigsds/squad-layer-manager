import { def, raw, t } from '@/models/messages.models'

// reason is the server's own explanation of which tag conflicts, so it is passed through verbatim
export const duplicateLabel = def((reason: string) => ({
	toast: [t('Duplicate label'), { description: raw(reason) }],
}))

export const invalidTag = def((reason: string) => ({
	toast: [t('Invalid tag'), { description: raw(reason) }],
}))

export const saveFailed = def(() => ({
	toast: [t('Failed to save tag')],
}))

// -------- the tag editor --------

export const labelColumn = def('Label')

export const descriptionColumn = def('Description')

export const colorColumn = def('Color')

export const preventSwapsColumn = def('Prevent swaps')

export const preventSwapsHint = def('Fixing repeats keeps the teams of a layer with this tag as they are, and only moves the layer.')

export const descriptionPlaceholder = def('Shown when hovering the tag')

export const pickColor = def('Pick color')

export const deleteTag = def('Delete tag')

// -------- a tag on a queue item --------

export const removeTag = def('Remove {label}', (label: string) => ({ label }))

// a tag id that no configured tag claims any more: the label is gone, but the id stays on every layer carrying it
export const deletedTag = def(
	'This tag has been deleted, so only the id it was created with remains. It can still be removed from the layer.',
)

export const noDescription = def('No description')

// on the card of the tag every item added from a saved rotation carries; the rotation's name follows as a link
export const fromRotation = def('Added to the queue from the rotation')

export const fromDeletedRotation = def('Added to the queue from a rotation that has since been deleted.')

export const editTag = def('Edit tag')

export const taggedBy = def('Tagged by')

export const addTag = def('Add tag')

// the same affordance, shrunk to fit inline beside an untagged item

export const noTagsAvailable = def('No tags available')

// the queue item menu's submenu that switches an item's tags on and off
export const tagsSub = def('Tags')

export const newTagItem = def('New tag...')

// -------- the tag dialog --------

export const newTagTitle = def('New tag')

export const newTagBlurb = def('Tags are shared by everyone and can be attached to any layer in the queue.')

export const editTagBlurb = def('Renaming a tag keeps it attached to every layer already carrying it.')

export const newRotationTagBlurb = def('Rotation tags are shared by everyone and group rotations on the Rotations page.')

export const editRotationTagBlurb = def('Renaming a tag keeps it attached to every rotation already carrying it.')

export const labelPlaceholder = def('e.g. meta')

export const duplicateLabelInline = def('Another tag is already labeled "{label}"', (label: string) => ({ label }))

// stands in for the label in the live chip preview while the field is empty
export const previewLabel = def('preview')

export const cancel = def('Cancel')

export const create = def('Create')

export const save = def('Save')
