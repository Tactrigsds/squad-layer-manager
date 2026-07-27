import * as Msgs from '@/messages/shared'
import type * as CHAT from '@/models/chat.models'

export const secondaryFilterLabels: Record<CHAT.SecondaryFilterState, string> = {
	ALL: 'All',
	DEFAULT: 'Default',
	CHAT: 'Chat',
	SLM_EVENTS: 'SLM Events',
	ADMIN: 'Admin',
	KILLFEED: 'Killfeed',
}

// Both chat boxes report a send failure the same way: the result code when the call answered, nothing when it threw.
export const sendFailed = Msgs.def((code?: string) => ({
	toast: (): Msgs.ToastArgs => (code === undefined ? ['Failed to send'] : ['Failed to send', { description: code }]),
}))
