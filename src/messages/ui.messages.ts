import * as Msgs from '@/messages/shared'

// What the shared widgets say about themselves, regardless of what they are showing. A combo box says "Search
// options..." whether it holds layers or roles, so this vocabulary belongs to the widget rather than to any domain.

// -------- combo boxes --------

export const searchOptions = Msgs.def('Search options...')

// The picker names what it holds, which the caller supplies as a bare noun and this pluralizes. The rule is at
// least in the messages tree now; a locale that cannot pluralize by suffix still needs the noun itself, so this
// stays i18n debt rather than a finished message.
export const selectedCount = Msgs.def(
	(noun: string | undefined, count: number, limit?: number) => `Selected ${noun ? noun + 's ' : ''}(${count}${limit ? `/${limit}` : ''})`,
)

export const resetToInitial = Msgs.def('Reset to Initial')

export const selectAll = Msgs.def('Select All')

export const clearAll = Msgs.def('Clear All')

export const noResults = Msgs.def('No results found.')

export const nothingSelected = Msgs.def('No items selected')

// -------- pagination --------

export const pagination = Msgs.def('pagination')

export const previousPage = Msgs.def('Previous')

export const previousPageHint = Msgs.def('Go to previous page')

export const nextPage = Msgs.def('Next')

export const nextPageHint = Msgs.def('Go to next page')

export const morePages = Msgs.def('More pages')

export const firstPageHint = Msgs.def('First page')

export const lastPageHint = Msgs.def('Last page')

export const previousPageShortHint = Msgs.def('Previous page')

export const nextPageShortHint = Msgs.def('Next page')

export const pageNumber = Msgs.def('Page number')

// -------- dialogs, windows and the rest --------

export const close = Msgs.def('Close')

export const closeWindow = Msgs.def('Close window')

export const cancel = Msgs.def('Cancel')

export const loading = Msgs.def('Loading')

export const loadingEllipsis = Msgs.def('Loading...')

export const invertHint = Msgs.def('Ctrl+Click to invert')
