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

// Editing your own profile.

export const nicknameUpdated = Msgs.def(() => ({ toast: () => ['Nickname updated successfully!'] }))

export const nicknameRejected = Msgs.def((reason: string) => ({
	toast: () => ['Error updating nickname', { description: reason }],
}))

// the request threw rather than answering, so there is nothing of the server's to quote
export const nicknameUpdateFailed = Msgs.def(() => ({
	toast: () => ['Failed to update nickname', { description: 'An unexpected error occurred' }],
}))

export const steamAccountsUpdated = Msgs.def(() => ({ toast: () => ['Linked Steam accounts updated'] }))

export const steamIdAlreadyLinked = Msgs.def((steamId: string) => ({
	toast: () => ['Steam ID already linked', { description: `${steamId} is linked to another account.` }],
}))

export const steamUpdateFailed = Msgs.def((reason: string) => ({
	toast: () => ['Failed to update', { description: reason }],
}))

// One toast for the whole condition, kept alive and updated in place while it holds, so its id, its infinite
// duration and its action handler stay at the call site.
export const otherSessionsActive = Msgs.def((count: number) => ({
	toast: () => ['Other sessions active', { description: `You're active in ${count} other session${count > 1 ? 's' : ''}.` }],
}))

export const resetOtherSessions = Msgs.def(() => ({ text: () => 'Reset them' }))
