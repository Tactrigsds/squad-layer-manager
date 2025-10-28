import * as Obj from '@/lib/object'
import * as SLL from '@/models/shared-layer-list'
import { b } from 'vitest/dist/chunks/mocker.d.BE_2ls6u.js'

export type ActionInput = { hasEdits: boolean; prev?: SLL.ClientPresence }
export type ActionOutput = Partial<Omit<SLL.ClientPresence, 'userId'>>
export type Action = (input: ActionInput) => ActionOutput

function isPresenceEditing(presence: SLL.ClientPresence | null, hasEdits: boolean) {
	if (!presence || presence.away) return false
	if (presence.currentActivity) {
		if (SLL.isItemOwnedActivity(presence.currentActivity) || presence.currentActivity.code === 'adding-item') {
			return true
		}
	}
	return hasEdits
}

const withEditing = (prevAction: Action): Action => (input) => {
	const prevOutput = prevAction(input)
	if (!input.prev) return prevOutput
	const presence = Obj.deepClone(input.prev)
	SLL.updateClientPresence(presence, prevOutput)
	return {
		...prevOutput,
		editing: isPresenceEditing(presence, input.hasEdits),
	}
}

export const pageLoaded: Action = withEditing((input) => {
	return {
		away: false,
		currentActivity: null,
		lastSeen: Date.now(),
	}
})

// the page has been interacted with or newly opened/navigated to
export const pageInteraction: Action = withEditing((input) => {
	return {
		away: false,
		lastSeen: Date.now(),
	}
})

// export const INTERACT_TIMEOUT = 5_000
export const INTERACT_TIMEOUT = 30_000

// page has been idle for too long
export const interactionTimeout: Action = withEditing((input) => {
	return {
		away: true,
	}
})

// user went to another page
export const navigatedAway: Action = withEditing(() => {
	return {
		away: true,
		currentActivity: null,
		lastSeen: Date.now(),
	}
})

export const DISCONNECT_TIMEOUT = 5_000

// user disconnected, and hasn't reconnected after some timeout
export const disconnectedTimeout: Action = withEditing(() => {
	return {
		away: true,
		currentActivity: null,
	}
})

export const startActivity = (activity: SLL.Activity): Action => {
	return withEditing(() => ({
		away: false,
		currentActivity: activity,
		lastSeen: Date.now(),
	}))
}

export const endActivity = (activity?: SLL.Activity): Action =>
	withEditing((input) => {
		let newActivity: SLL.Activity | null = null
		if (activity) {
			newActivity = Obj.deepEqual(activity, input.prev?.currentActivity) ? null : input.prev!.currentActivity
		}
		return {
			away: false,
			currentActivity: newActivity,
			lastSeen: Date.now(),
		}
	})

// the queue has been permanently written to
export const editSessionChanged: Action = withEditing(() => {
	return {
		currentActivity: null,
	}
})

export const failedToAcquireLocks = (beforeUpdates: SLL.ClientPresence): Action =>
	withEditing(() => {
		return {
			...beforeUpdates,
		}
	})

export function applyToAll(state: SLL.PresenceState, session: SLL.EditSession, action: Action): SLL.PresenceState {
	for (const key of state.keys()) {
		const userId = state.get(key)!.userId!
		const hasEdits = SLL.checkUserHasEdits(session, userId)
		const update = action({ hasEdits: hasEdits, prev: state.get(key) })
		const presence = state.get(key)!
		SLL.updateClientPresence(presence, update)
	}
	return state
}
