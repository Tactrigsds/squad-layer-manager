import type * as UP from '@/models/user-presence'

// Shown next to a user's avatar for a few seconds after one of their ops lands on the synced timeline, so it
// reads as a completed action rather than as the op name.
export const presenceEventText: Record<UP.PresenceEventAction, string> = {
	'added-layers': 'Added layers',
	'swapped-factions': 'Swapped factions',
	'deleted-item': 'Deleted an item',
	'cloned-item': 'Cloned an item',
	'moved-item': 'Moved an item',
	'added-tag': 'Added a tag',
	'added-note': 'Added a note',
	'saved-queue': 'Saved the queue',
	'discarded-queue-edits': 'Discarded queue edits',
	'saved-teamswaps': 'Saved teamswaps',
	'executed-teamswaps': 'Executed teamswaps',
	'added-teamswap': 'Added a teamswap',
	'removed-teamswap': 'Removed a teamswap',
	'cleared-teamswaps': 'Cleared teamswaps',
	'discarded-teamswap-edits': 'Discarded teamswap edits',
	'swapped-players-now': 'Swapped players',
	'added-layer-request': 'Added a layer request',
	'edited-layer-request': 'Edited a layer request',
	'removed-layer-request': 'Removed a layer request',
	'moved-layer-request': 'Moved a layer request',
	'combined-layer-requests': 'Combined layer requests',
	'saved-layer-requests': 'Saved layer requests',
	'discarded-layer-request-edits': 'Discarded layer request edits',
}
