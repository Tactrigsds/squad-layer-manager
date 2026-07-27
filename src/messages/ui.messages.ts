import * as Msgs from '@/messages/shared'

// What the shared widgets say about themselves, regardless of what they are showing. A combo box says "Search
// options..." whether it holds layers or roles, so this vocabulary belongs to the widget rather than to any domain.

// -------- combo boxes --------

export const searchOptions = Msgs.def(() => ({ text: () => 'Search options...' }))

// The picker names what it holds, which the caller supplies as a bare noun and this pluralizes. The rule is at
// least in the messages tree now; a locale that cannot pluralize by suffix still needs the noun itself, so this
// stays i18n debt rather than a finished message.
export const selectedCount = Msgs.def((noun: string | undefined, count: number, limit?: number) => ({
	text: () => `Selected ${noun ? noun + 's ' : ''}(${count}${limit ? `/${limit}` : ''})`,
}))

export const resetToInitial = Msgs.def(() => ({ text: () => 'Reset to Initial' }))

export const selectAll = Msgs.def(() => ({ text: () => 'Select All' }))

export const clearAll = Msgs.def(() => ({ text: () => 'Clear All' }))

export const noResults = Msgs.def(() => ({ text: () => 'No results found.' }))

export const nothingSelected = Msgs.def(() => ({ text: () => 'No items selected' }))

// -------- pagination --------

export const pagination = Msgs.def(() => ({ text: () => 'pagination' }))

export const previousPage = Msgs.def(() => ({ text: () => 'Previous' }))

export const previousPageHint = Msgs.def(() => ({ text: () => 'Go to previous page' }))

export const nextPage = Msgs.def(() => ({ text: () => 'Next' }))

export const nextPageHint = Msgs.def(() => ({ text: () => 'Go to next page' }))

export const morePages = Msgs.def(() => ({ text: () => 'More pages' }))

export const firstPageHint = Msgs.def(() => ({ text: () => 'First page' }))

export const lastPageHint = Msgs.def(() => ({ text: () => 'Last page' }))

export const previousPageShortHint = Msgs.def(() => ({ text: () => 'Previous page' }))

export const nextPageShortHint = Msgs.def(() => ({ text: () => 'Next page' }))

export const pageNumber = Msgs.def(() => ({ text: () => 'Page number' }))

// -------- dialogs, windows and the rest --------

export const close = Msgs.def(() => ({ text: () => 'Close' }))

export const closeWindow = Msgs.def(() => ({ text: () => 'Close window' }))

export const cancel = Msgs.def(() => ({ text: () => 'Cancel' }))

export const loading = Msgs.def(() => ({ text: () => 'Loading' }))

export const loadingEllipsis = Msgs.def(() => ({ text: () => 'Loading...' }))

export const invertHint = Msgs.def(() => ({ text: () => 'Ctrl+Click to invert' }))
