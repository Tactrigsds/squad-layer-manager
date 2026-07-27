import * as Msgs from '@/messages/shared'

// The sandbox window drives an emulated server, so its failures are the emulator's own words where it has any and
// the verb's result code otherwise.
export const verbFailed = Msgs.def((reason: string) => ({
	toast: () => ['Sandbox', { description: reason }],
}))

export const bulkJoinNeedsCount = Msgs.def(() => ({
	toast: () => ['Sandbox', { description: 'Enter how many players should connect' }],
}))
