import { def, t, type TString } from '@/models/messages.models'
import type * as UP from '@/models/user-presence'

// Shown next to a user's avatar for a few seconds after one of their ops lands on the synced timeline, so it
// reads as a completed action rather than as the op name.
export const presenceEventText: Record<UP.PresenceEventAction, TString> = {
	'added-layers': t('Added layers'),
	'swapped-factions': t('Swapped factions'),
	'deleted-item': t('Deleted an item'),
	'cloned-item': t('Cloned an item'),
	'moved-item': t('Moved an item'),
	'added-tag': t('Added a tag'),
	'added-note': t('Added a note'),
	'saved-queue': t('Saved the queue'),
	'discarded-queue-edits': t('Discarded queue edits'),
	'saved-teamswaps': t('Saved teamswaps'),
	'executed-teamswaps': t('Executed teamswaps'),
	'added-teamswap': t('Added a teamswap'),
	'removed-teamswap': t('Removed a teamswap'),
	'cleared-teamswaps': t('Cleared teamswaps'),
	'discarded-teamswap-edits': t('Discarded teamswap edits'),
	'swapped-players-now': t('Swapped players'),
	'added-layer-request': t('Added a layer request'),
	'edited-layer-request': t('Edited a layer request'),
	'removed-layer-request': t('Removed a layer request'),
	'moved-layer-request': t('Moved a layer request'),
	'combined-layer-requests': t('Combined layer requests'),
	'saved-layer-requests': t('Saved layer requests'),
	'discarded-layer-request-edits': t('Discarded layer request edits'),
	'saved-filter': t('Saved the filter'),
	'discarded-filter-edits': t('Discarded filter edits'),
}

// -------- the presence panel --------

export const resetSession = def('Reset this session')

// reads as "Last seen <relative time>"
export const lastSeen = def('Last seen')

// marks whichever avatar is the viewer's own
// the reader's own row is marked in the name itself, so a locale can put the marker where its language wants it
export const displayNameWithYou = def('{name}{isYou, select, yes { (You)} other {}}', (name: string, isYou: boolean) => ({
	name,
	isYou: isYou ? 'yes' : 'no',
}))
