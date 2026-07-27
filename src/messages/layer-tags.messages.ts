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

export const labelColumn = Msgs.def(() => ({ text: () => 'Label' }))

export const descriptionColumn = Msgs.def(() => ({ text: () => 'Description' }))

export const colorColumn = Msgs.def(() => ({ text: () => 'Color' }))

export const descriptionPlaceholder = Msgs.def(() => ({ text: () => 'Shown when hovering the tag' }))

export const pickColor = Msgs.def(() => ({ text: () => 'Pick color' }))

export const deleteTag = Msgs.def(() => ({ text: () => 'Delete tag' }))
