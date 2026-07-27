import * as Msgs from '@/messages/shared'

// App-level text belonging to no narrower domain, and the home for a message two domains share.

// what was copied goes in the description, since the title is the same wherever the app copies something
export const copiedToClipboard = Msgs.def((what: string) => ({
	toast: () => ['Copied to clipboard', { description: what }],
}))
