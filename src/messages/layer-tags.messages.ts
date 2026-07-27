import * as Msgs from '@/messages/shared'

// reason is the server's own explanation of which tag conflicts, so it is passed through verbatim
export const duplicateLabel = Msgs.def((reason: string) => ({
	toast: () => ['Duplicate label', { description: reason }],
}))

export const invalidTag = Msgs.def((reason: string) => ({
	toast: () => ['Invalid tag', { description: reason }],
}))

export const saveFailed = Msgs.def(() => ({
	toast: () => ['Failed to save tag'],
}))

// -------- the tag editor --------

export const labelColumn = Msgs.def('Label')

export const descriptionColumn = Msgs.def('Description')

export const colorColumn = Msgs.def('Color')

export const descriptionPlaceholder = Msgs.def('Shown when hovering the tag')

export const pickColor = Msgs.def('Pick color')

export const deleteTag = Msgs.def('Delete tag')

// -------- a tag on a queue item --------

export const removeTag = Msgs.def('Remove {label}', (label: string) => ({ label }))

// a tag id that no configured tag claims any more: the label is gone, but the id stays on every layer carrying it
export const deletedTag = Msgs.def(
	'This tag has been deleted, so only the id it was created with remains. It can still be removed from the layer.',
)

export const noDescription = Msgs.def('No description')

export const editTag = Msgs.def('Edit tag')

export const taggedBy = Msgs.def('Tagged by')

export const addTag = Msgs.def('Add tag')

// the same affordance, shrunk to fit inline beside an untagged item
export const addTagInline = Msgs.def('add tag')

export const noTagsAvailable = Msgs.def('No tags available')

export const newTagItem = Msgs.def('New tag...')

// -------- the tag dialog --------

export const newTagTitle = Msgs.def('New tag')

export const newTagBlurb = Msgs.def('Tags are shared by everyone and can be attached to any layer in the queue.')

export const editTagBlurb = Msgs.def('Renaming a tag keeps it attached to every layer already carrying it.')

export const labelPlaceholder = Msgs.def('e.g. meta')

export const duplicateLabelInline = Msgs.def('Another tag is already labeled "{label}"', (label: string) => ({ label }))

// stands in for the label in the live chip preview while the field is empty
export const previewLabel = Msgs.def('preview')

export const cancel = Msgs.def('Cancel')

export const create = Msgs.def('Create')

export const save = Msgs.def('Save')
