import * as Msgs from '@/messages/shared'

// The layer table's clipboard receipts. Unlike SM_Msgs.copiedToClipboard these put what was copied in the
// toast itself rather than in a description, and only the history-entry one pluralizes.
export const copiedSetNextCommand = Msgs.def(() => ({
	toast: () => ['Copied AdminSetNextLayer Command'],
}))

export const copiedLayerIds = Msgs.def(() => ({
	toast: () => ['Copied Layer ID'],
}))

export const copiedHistoryEntryIds = Msgs.def((count: number) => ({
	toast: () => [`Copied History Entry ID${count > 1 ? 's' : ''}`],
}))
