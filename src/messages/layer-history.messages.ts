import { def } from '@/models/messages.models'

export const title = def('Queue item history')

// the menu item on a queue item and a match history row that opens the window
export const viewHistory = def('View history')

export const openInHistory = def('Open in History')

export const queuePosition = def('Queue #{position}', (position: number) => ({ position }))

export const playedInMatch = def('Played in match {id}', (id: number) => ({ id }))

// a match whose layer SLM did not set from the queue has no queue item to follow
export const noQueueItem = def('This layer was not set from the queue, so only its match events are shown.')
