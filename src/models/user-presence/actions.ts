import * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'

export type ActionInput = { hasEdits: boolean; prev?: UP.ClientPresence }
export type ActionOutput = Partial<Omit<UP.ClientPresence, 'userId'>>
export type Action = (input: ActionInput) => ActionOutput

export function getClientPresenceDefaults(userId: bigint): UP.ClientPresence {
	return {
		userId,
		away: true,
		activityState: null,
		lastSeen: null,
	}
}

export const pageLoaded: Action = (_input) => {
	return {
		away: false,
		activityState: null,
	}
}

// the page has been interacted with or newly opened/navigated to
export const pageInteraction: Action = (_input) => {
	return {
		away: false,
		lastSeen: Date.now(),
	}
}

// export const INTERACT_TIMEOUT = 5_000
export const INTERACT_TIMEOUT = 30_000

// page has been idle for too long
export const interactionTimeout: Action = (_input) => {
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

export const updateActivity = (activity: UP.RootActivity): Action => {
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

export const failedToAcquireLocks = (beforeUpdates: UP.ClientPresence): Action => () => {
	return {
		...beforeUpdates,
	}
}

export function applyToAll(state: UP.PresenceState, session: SLL.EditSession, action: Action): UP.PresenceState {
	for (const key of state.keys()) {
		const userId = state.get(key)!.userId!
		const hasEdits = SLL.hasMutations(session, userId)
		const update = action({ hasEdits: hasEdits, prev: state.get(key) })
		const presence = state.get(key)!
		UP.updateClientPresence(presence, update)
	}
	return state
}
