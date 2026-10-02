import { def, type Rendered, rt, t } from '@/models/messages.models'

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

// a grouping with too many groups to tab through is picked from its own list instead. The button already
// reads "<grouping>: <group>", so only the hint has to say what it does.
export const narrowByGrouping = def('Narrow by {grouping}', (grouping: string) => ({ grouping }))

// leaves that list without picking, back to the options
export const backToOptions = def('Back to options')

export const nothingSelected = def('No items selected')

// -------- drag and drop --------

// what a screen reader calls a drag handle, in place of "button"
export const dragRoleDescription = def('draggable')

// read by screen readers on every drag handle
export const dragInstructions = def(
	'To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item in a given direction. Press space again to drop the item in its new position, or press escape to cancel.',
)

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

export const back = def('Back')

export const closeWindow = def('Close window')

export const cancel = def('Cancel')

export const loading = def('Loading')

export const loadingEllipsis = def('Loading...')

export const invertHint = def('Ctrl+Click to invert')

// the text editors' block/compact switch: compact collapses short maps and lists onto one line
export const compact = def('Compact')

export const compactHint = def('Collapse short maps and lists onto one line')

export const done = def('Done')

export const confirm = def('Confirm')

export const search = def('Search...')

export const showMore = def('Show more')

export const showLess = def('Show less')

export const expand = def('Expand')

export const collapse = def('Collapse')

export const addComment = def('Add comment')

export const editComment = def('Edit comment')

// -------- composition --------

// a label and what it labels, "Reason: spamming". The tag spans the label and its punctuation, which a caller may style.
export const labelValue = def((label: Rendered, value: Rendered) => rt('<label>{name}:</label> {value}', { name: label, value }))

// the marker before an item of a numbered list
export const listMarker = def('{position}.', (position: number) => ({ position }))

// -------- shared edit sessions --------

// The save button of anything several users edit at once. It only saves once nobody else is still editing; until
// then it only ends the viewer's own part in the session.

export const forceSave = def('Force Save')

export const save = def('Save')

export const saveAnyway = def('Save Anyway')

export const finishEditing = def('Finish Editing')

export const finishEditingAnyway = def('Finish Editing Anyway')
