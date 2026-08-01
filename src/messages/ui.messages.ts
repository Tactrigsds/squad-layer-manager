import { def, t } from '@/models/messages.models'

// What the shared widgets say about themselves, regardless of what they are showing. A combo box says "Search
// options..." whether it holds layers or roles, so this vocabulary belongs to the widget rather than to any domain.

// -------- combo boxes --------

export const searchOptions = def('Search options...')

// The picker names what it holds, which the caller supplies as a bare noun and this pluralizes. The rule is at
// least in the messages tree now; a locale that cannot pluralize by suffix still needs the noun itself, so this
// stays i18n debt rather than a finished message.
export const selectedCount = def((noun: string | undefined, count: number, limit?: number) => {
	if (noun === undefined)
		return limit === undefined ? t('Selected ({count})', { count }) : t('Selected ({count}/{limit})', { count, limit })
	return limit === undefined
		? t('Selected {noun}s ({count})', { noun, count })
		: t('Selected {noun}s ({count}/{limit})', { noun, count, limit })
})

export const resetToInitial = def('Reset to Initial')

export const selectAll = def('Select All')

export const clearAll = def('Clear All')

export const noResults = def('No results found.')

// the tab that lifts the group filter, showing every group's options at once
export const allGroups = def('All')

export const nothingSelected = def('No items selected')

// -------- pagination --------

export const pagination = def('pagination')

export const previousPage = def('Previous')

export const previousPageHint = def('Go to previous page')

export const nextPage = def('Next')

export const nextPageHint = def('Go to next page')

export const morePages = def('More pages')

export const firstPageHint = def('First page')

export const lastPageHint = def('Last page')

export const previousPageShortHint = def('Previous page')

export const nextPageShortHint = def('Next page')

export const pageNumber = def('Page number')

// -------- dialogs, windows and the rest --------

export const close = def('Close')

export const closeWindow = def('Close window')

export const cancel = def('Cancel')

export const loading = def('Loading')

export const loadingEllipsis = def('Loading...')

export const invertHint = def('Ctrl+Click to invert')
