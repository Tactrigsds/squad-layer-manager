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

// -------- the landing pages --------
// The unauthenticated entry to the app, rendered to static HTML at boot (see landing.server.ts). guildName is
// null when the instance does not know which Discord it belongs to, which is what the vaguer wording is for.

function where(guildName: string | null) {
	return guildName ? ` in ${guildName}` : ' in the configured Discord'
}

// which of the three pages is being rendered. Declared here because the titles are the only thing keyed by it and
// both the component and landing.server.ts were spelling the union out.
export type LandingVariant = 'landing' | 'no-auth' | 'forbidden'

export const landingTitles: Record<LandingVariant, string> = {
	landing: 'Squad Layer Manager',
	'no-auth': 'Sign in - Squad Layer Manager',
	forbidden: 'Access denied - Squad Layer Manager',
}

export const landingHeading = Msgs.def((guildName: string | null) => ({
	text: () => (guildName ? `You have reached the SLM instance for ${guildName}.` : 'You have reached this Squad Layer Manager instance.'),
}))

export const landingBlurb = Msgs.def((guildName: string | null) => ({
	text: () => `To access this site you must sign in with a Discord account that has sufficient privileges${where(guildName)}.`,
}))

export const logInWithDiscord = Msgs.def(() => ({ text: () => 'Log in with Discord' }))

export const viewOnGithub = Msgs.def(() => ({ text: () => 'View on GitHub' }))

export const pickANameHeading = Msgs.def(() => ({ text: () => 'Pick a name' }))

export const pickANameBlurb = Msgs.def(() => ({
	text: () => 'This instance runs without authentication. Whatever you type here is who you are, and anyone else can be them too.',
}))

export const usernameLabel = Msgs.def(() => ({ text: () => 'Username' }))

export const continueLabel = Msgs.def(() => ({ text: () => 'Continue' }))

export const accessDeniedHeading = Msgs.def(() => ({ text: () => 'Access denied' }))

export const accessDeniedBlurb = Msgs.def((guildName: string | null) => ({
	text: () => `Your Discord account does not have sufficient privileges${where(guildName)} to access this site.`,
}))

export const backToHome = Msgs.def(() => ({ text: () => 'Back to home' }))

export const logOutAndSwitch = Msgs.def(() => ({ text: () => 'Log out and switch account' }))

export const accessDeniedContact = Msgs.def(() => ({ text: () => 'If you believe this is a mistake, contact an administrator.' }))

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

export const steamLinkAssigned = Msgs.def((discordName: string) => ({
	toast: () => ['Steam account linked', { description: `Linked to ${discordName}.` }],
}))

export const steamLinkRemoved = Msgs.def(() => ({ toast: () => ['Steam link removed'] }))

// the picker only searches the home guild, so an id typed in by hand is the way to reach this
export const steamLinkNotAGuildMember = Msgs.def((discordId: string) => ({
	toast: () => ['Not a member of this Discord', { description: `${discordId} could not be resolved in the home guild.` }],
}))

export const steamLinkFailed = Msgs.def(() => ({ toast: () => ['Failed to update the link'] }))

// One toast for the whole condition, kept alive and updated in place while it holds, so its id, its infinite
// duration and its action handler stay at the call site.
export const otherSessionsActive = Msgs.def((count: number) => ({
	toast: () => ['Other sessions active', { description: `You're active in ${count} other session${count > 1 ? 's' : ''}.` }],
}))

export const resetOtherSessions = Msgs.def(() => ({ text: () => 'Reset them' }))

// -------- a player's discord link --------

export const discordLabel = Msgs.def(() => ({ text: () => 'Discord' }))

export const linkedBy = Msgs.def((admin?: string) => ({ text: () => `linked by ${admin ?? 'an admin'}` }))

export const selfLinked = Msgs.def(() => ({ text: () => 'self-linked' }))

export const unlink = Msgs.def(() => ({ text: () => 'Unlink' }))

// -------- the nickname dialog --------

export const nicknameDialogTitle = Msgs.def(() => ({ text: () => 'Set Custom Nickname' }))

export const nicknameDialogBlurb = Msgs.def(() => ({
	text: () =>
		'Choose a custom nickname that will be displayed instead of your Discord name. Leave empty to use your Discord display name.',
}))

export const nicknameFieldLabel = Msgs.def(() => ({ text: () => 'Nickname' }))

export const nicknamePlaceholder = Msgs.def(() => ({ text: () => 'Enter a custom nickname...' }))

export const nicknamePreview = Msgs.def((nickname: string) => ({ text: () => `Will display as: "${nickname}"` }))

export const nicknameFallsBackToDiscord = Msgs.def(() => ({ text: () => 'Will use Discord display name' }))

export const nicknameTooLong = Msgs.def(() => ({ text: () => 'Nickname must be 64 characters or less' }))

export const save = Msgs.def(() => ({ text: () => 'Save' }))

export const saving = Msgs.def(() => ({ text: () => 'Saving...' }))

// -------- the linked steam accounts dialog --------

export const steamDialogTitle = Msgs.def(() => ({ text: () => 'Linked Steam Accounts' }))

export const steamDialogBlurb = Msgs.def(() => ({
	text: () =>
		'Link your Steam64 IDs so in-game admin commands (like /kick) recognize you. Add as many as you need. Links an admin made on your behalf are listed here too, and you can remove them.',
}))

export const steamIdPlaceholder = Msgs.def(() => ({ text: () => '17-digit Steam64 ID' }))

export const steamLinkedByAdmin = Msgs.def((admin: string) => ({ text: () => `Linked by ${admin}` }))

// -------- the discord role and member pickers --------

export const discordRolePicker = Msgs.def(() => ({ text: () => 'role' }))

export const discordRoleUnresolved = Msgs.def(() => ({
	text: () => 'This Discord role no longer exists in the server (its id is shown). Pick another role or remove this assignment.',
}))

export const discordMemberPicker = Msgs.def(() => ({ text: () => 'member' }))

export const discordMemberPlaceholder = Msgs.def(() => ({ text: () => 'Search members…' }))

export const discordMemberSearchPlaceholder = Msgs.def(() => ({ text: () => 'Search by name or id…' }))

export const noDiscordMembersFound = Msgs.def(() => ({ text: () => 'No members found.' }))

export const searchDiscordMembers = Msgs.def(() => ({ text: () => 'Type a name or id to search members.' }))

export const discordMemberUnresolved = Msgs.def(() => ({
	text: () =>
		"This Discord user isn't a current server member (their id is shown). They may have left the server, or are otherwise unknown.",
}))
