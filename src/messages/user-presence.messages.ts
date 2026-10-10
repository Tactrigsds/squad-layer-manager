import { assertNever } from '@/lib/type-guards'
import { def, t, type TString } from '@/models/messages.models'
import type * as UP from '@/models/user-presence.models'

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

export const lastSeen = def('Last seen {when}', (when: string) => ({ when }))

// marks whichever avatar is the viewer's own
// the reader's own row is marked in the name itself, so a locale can put the marker where its language wants it
export const displayNameWithYou = def('{name}{isYou, select, yes { (You)} other {}}', (name: string, isYou: boolean) => ({
	name,
	isYou: isYou ? 'yes' : 'no',
}))

// -------- what a user is doing --------

export const activity = def((a: UP.ActivityDescriptor) => {
	switch (a.id) {
		case 'EDITING_FILTER':
			return t('Editing Filter')
		case 'EDITING_TEAMSWAPS':
			return t('Editing Scheduled Teamswaps')
		case 'EDITING_LAYER_REQUESTS':
			return t('Editing Layer Requests')
		case 'SWITCHING_PLAYERS':
			return t('Switching players Now')
		case 'WARNING_PLAYERS':
			return t('Warning players')
		case 'REMOVING_FROM_SQUAD':
			return t('Removing from squad')
		case 'DISBANDING_SQUAD':
			return t('Disbanding squad')
		case 'RESETTING_SQUAD_NAME':
			return t('Resetting squad name')
		case 'DEMOTING_COMMANDER':
			return t('Demoting commander')
		case 'CHANGING_QUEUE_SETTINGS':
			return t('Changing Pool Settings')
		case 'ADDING_ITEM':
			return t('Adding layers')
		case 'GENERATING_VOTE':
			return t('Generating vote')
		case 'ADDING_ITEM_FROM_HISTORY':
			return t('Adding layer from History')
		case 'PASTE_ROTATION':
			return t('Pasting rotation')
		case 'EDITING_ITEM':
			return a.itemName === undefined ? t('Editing') : t('Editing {item}', { item: a.itemName })
		case 'CONFIGURING_VOTE':
			return a.itemName === undefined ? t('Configuring vote') : t('Configuring vote for {item}', { item: a.itemName })
		case 'MOVING_ITEM':
			return a.itemName === undefined ? t('Moving') : t('Moving {item}', { item: a.itemName })
		case 'IDLE':
			return t('Editing Queue')
		default:
			assertNever(a.id)
	}
})

// a queue item's badge naming who is working on it
export const attributedActivity = def((name: string, a: UP.ActivityDescriptor) => {
	switch (a.id) {
		case 'EDITING_FILTER':
			return t('{name} is editing a filter...', { name })
		case 'EDITING_TEAMSWAPS':
			return t('{name} is editing scheduled teamswaps...', { name })
		case 'EDITING_LAYER_REQUESTS':
			return t('{name} is editing layer requests...', { name })
		case 'SWITCHING_PLAYERS':
			return t('{name} is switching players now...', { name })
		case 'WARNING_PLAYERS':
			return t('{name} is warning players...', { name })
		case 'REMOVING_FROM_SQUAD':
			return t('{name} is removing from squad...', { name })
		case 'DISBANDING_SQUAD':
			return t('{name} is disbanding squad...', { name })
		case 'RESETTING_SQUAD_NAME':
			return t('{name} is resetting squad name...', { name })
		case 'DEMOTING_COMMANDER':
			return t('{name} is demoting commander...', { name })
		case 'CHANGING_QUEUE_SETTINGS':
			return t('{name} is changing pool settings...', { name })
		case 'ADDING_ITEM':
			return t('{name} is adding layers...', { name })
		case 'GENERATING_VOTE':
			return t('{name} is generating vote...', { name })
		case 'ADDING_ITEM_FROM_HISTORY':
			return t('{name} is adding layer from history...', { name })
		case 'PASTE_ROTATION':
			return t('{name} is pasting rotation...', { name })
		case 'EDITING_ITEM':
			return a.itemName === undefined
				? t('{name} is editing...', { name })
				: t('{name} is editing {item}...', { name, item: a.itemName })
		case 'CONFIGURING_VOTE':
			return a.itemName === undefined
				? t('{name} is configuring vote...', { name })
				: t('{name} is configuring vote for {item}...', { name, item: a.itemName })
		case 'MOVING_ITEM':
			return a.itemName === undefined ? t('{name} is moving...', { name }) : t('{name} is moving {item}...', { name, item: a.itemName })
		case 'IDLE':
			return t('{name} is editing queue...', { name })
		default:
			assertNever(a.id)
	}
})
