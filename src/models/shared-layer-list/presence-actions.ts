import * as SLL from '@/models/shared-layer-list'

export type ActionInput = { hasEdits: boolean; prev?: SLL.ClientPresence }
export type ActionOutput = Partial<Omit<SLL.ClientPresence, 'userId'>>
export type Action = (input: ActionInput) => ActionOutput

// the page has been interacted with or newly opened/navigated to
export const pageInteraction: Action = (input) => {
	return {
		away: false,
		editing: (input.hasEdits || !!input.prev?.currentActivity) ? true : undefined,
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
		editing: false,
		currentActivity: null,
		lastSeen: Date.now(),
	}
}

export const DISCONNECT_TIMEOUT = 5_000

// user disconnected, and hasn't reconnected after some timeout
export const disconnectedTimeout: Action = () => {
	return {
		away: true,
		editing: false,
		currentActivity: null,
	}
}

export const startActivity = (activity: SLL.ClientPresenceActivity): Action => {
	return () => ({
		away: false,
		editing: true,
		currentActivity: activity,
		lastSeen: Date.now(),
	})
}

export const endActivity: Action = (input) => {
	return {
		away: false,
		editing: input.hasEdits,
		currentActivity: null,
		lastSeen: Date.now(),
	}
}

// the queue has been permanently written to
export const editSessionChanged: Action = () => {
	return {
		editing: false,
		currentActivity: null,
	}
}

export const madeEditAction: Action = () => {
	return {
		editing: true,
		lastSeen: Date.now(),
	}
}

export const failedToAcquireLocks: Action = () => {
	return {
		currentActivity: null,
	}
}

export function applyToAll(state: SLL.PresenceState, session: SLL.EditSession, action: Action): SLL.PresenceState {
	for (const key of Object.keys(state)) {
		const userId = state.get(key)!.userId!
		const hasEdits = SLL.checkUserHasEdits(session, userId)
		const update = action({ hasEdits: hasEdits, prev: state.get(key) })
		SLL.updateClientPresence(key, userId, state, update)
	}
	return state
}
