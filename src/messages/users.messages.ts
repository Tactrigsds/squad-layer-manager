import * as Msgs from '@/messages/shared'

// Delivered as HTTP response bodies, which is the `text` surface rather than any player-facing one.
export const noApplicationAccess = Msgs.def(() => ({
	text: () => `You have not been granted access to this application. Please contact an administrator.`,
}))

export const unAuthenticated = Msgs.def(() => ({
	text: () => `Not able to authenticate user`,
}))

// what the no-auth login portal says back when the name posted to it is not one (see fastify.server)
export const invalidUsername = Msgs.def(() => ({
	text: () => `Pick a name of 1 to 32 letters, digits, spaces, dots, dashes or underscores.`,
}))
