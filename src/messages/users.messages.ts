import * as Msgs from '@/messages/shared'

// Delivered as HTTP response bodies, which is the `text` surface rather than any player-facing one.
export const noApplicationAccess = Msgs.def(() => ({
	text: () => `You have not been granted access to this application. Please contact an administrator.`,
}))

export const unAuthenticated = Msgs.def(() => ({
	text: () => `Not able to authenticate user`,
}))
