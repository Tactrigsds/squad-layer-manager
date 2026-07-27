import * as Msgs from '@/messages/shared'

// Both chat boxes report a send failure the same way: the result code when the call answered, nothing when it threw.
export const sendFailed = Msgs.def((code?: string) => ({
	toast: (): Msgs.ToastArgs => (code === undefined ? ['Failed to send'] : ['Failed to send', { description: code }]),
}))
