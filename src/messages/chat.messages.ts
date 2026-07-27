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

// -------- the activity feed --------

export const activityTitle = Msgs.def(() => ({ text: () => 'Server Activity' }))

export const viewingHistoricalMatch = Msgs.def(() => ({ text: () => 'Viewing historical match' }))

export const noPlayersSelected = Msgs.def(() => ({
	text: () => 'No players selected. Select players in the teams panel to filter the feed.',
}))

export const noEventsYet = Msgs.def((match: 'current' | 'historical') => ({
	text: () => (match === 'current' ? 'No events yet for current match' : 'No events yet for this match'),
}))

export const connectionLost = Msgs.def(() => ({ text: () => 'Connection lost - attempting to reconnect...' }))

export const reconnectionFailed = Msgs.def(() => ({
	text: () => 'Reconnection failed - unable to reconnect to the server. Please refresh the page.',
}))

export const scrollToBottom = Msgs.def(() => ({ text: () => 'Scroll to bottom' }))

export const newEvents = Msgs.def((count: number) => ({ text: () => `${count} new event${count === 1 ? '' : 's'}` }))

export const previousMatch = Msgs.def(() => ({ text: () => 'Previous match' }))

export const nextMatch = Msgs.def(() => ({ text: () => 'Next match' }))

export const returnToLive = Msgs.def(() => ({ text: () => 'Return to Live' }))

export const returnToLiveTooltip = Msgs.def(() => ({ text: () => 'Return to live events' }))

export const playersOnline = Msgs.def(() => ({ text: () => 'Players online' }))

export const playersInQueue = Msgs.def(() => ({ text: () => 'Players in queue' }))

export const serverTickRate = Msgs.def(() => ({ text: () => 'Server tick rate' }))
