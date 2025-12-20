import * as SLL from '@/models/shared-layer-list'

export type ActionInput = { hasEdits: boolean; prev?: SLL.ClientPresence }
export type ActionOutput = Partial<Omit<SLL.ClientPresence, 'userId'>>
export type Action = (input: ActionInput) => ActionOutput

export function getClientPresenceDefaults(userId: bigint): SLL.ClientPresence {
	return {
		userId,
		away: true,
		activityState: null,
		lastSeen: null,
	}
}

export const pageLoaded: Action = (input) => {
	return {
		away: false,
		activityState: null,
	}
}

// the page has been interacted with or newly opened/navigated to
export const pageInteraction: Action = (input) => {
	return {
		away: false,
		lastSeen: Date.now(),
	}
}

// export const INTERACT_TIMEOUT = 5_000
export const INTERACT_TIMEOUT = 30_000

// page has been idle for too long
export const interactionTimeout: Action = (input) => {
	return {
		away: true,
	}
}

// user went to another page
export const navigatedAway: Action = () => {
	return {
		away: true,
		activityState: null,
	}
}

export const DISCONNECT_TIMEOUT = 5_000

// user disconnected, and hasn't reconnected after some timeout
export const disconnectedTimeout: Action = () => {
	return {
		away: true,
		activityState: null,
	}
}

export const updateActivity = (activity: SLL.RootActivity): Action => {
	return () => ({
		away: false,
		activityState: activity,
		lastSeen: Date.now(),
	})
}

// the queue has been permanently written to
export const editSessionChanged: Action = () => {
	return {
		activityState: null,
	}
}

export const failedToAcquireLocks = (beforeUpdates: SLL.ClientPresence): Action => () => {
	return {
		...beforeUpdates,
	}
}

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
