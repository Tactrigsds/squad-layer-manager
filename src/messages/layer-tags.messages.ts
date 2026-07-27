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
