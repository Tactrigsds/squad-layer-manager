import * as Msgs from '@/messages/shared'

// Delivered as HTTP response bodies, which is the `text` surface rather than any player-facing one.
export const noApplicationAccess = Msgs.def(
	'You have not been granted access to this application. Please contact an administrator.',
	() => ({}),
)

export const unAuthenticated = Msgs.def('Not able to authenticate user')

// what the no-auth login portal says back when the name posted to it is not one (see fastify.server)
export const invalidUsername = Msgs.def('Pick a name of 1 to 32 letters, digits, spaces, dots, dashes or underscores.')

// -------- the landing pages --------
// The unauthenticated entry to the app, rendered to static HTML at boot (see landing.server.ts). guildName is
// null when the instance does not know which Discord it belongs to, which is what the vaguer wording is for.

function where(guildName: string | null) {
	return guildName ?? 'the configured Discord'
}

// which of the three pages is being rendered. Declared here because the titles are the only thing keyed by it and
// both the component and landing.server.ts were spelling the union out.
export type LandingVariant = 'landing' | 'no-auth' | 'forbidden'

export const landingTitles: Record<LandingVariant, string> = {
	landing: 'Squad Layer Manager',
	'no-auth': 'Sign in - Squad Layer Manager',
	forbidden: 'Access denied - Squad Layer Manager',
}

export const landingHeading = Msgs.def(
	'{named, select, yes {You have reached the SLM instance for {guildName}.} other {You have reached this Squad Layer Manager instance.}}',
	(guildName: string | null) => ({ guildName, named: guildName ? 'yes' : 'no' }),
)

export const landingBlurb = Msgs.def(
	'To access this site you must sign in with a Discord account that has sufficient privileges in {where}.',
	(guildName: string | null) => ({ where: where(guildName) }),
)

export const logInWithDiscord = Msgs.def('Log in with Discord')

export const viewOnGithub = Msgs.def('View on GitHub')

export const pickANameHeading = Msgs.def('Pick a name')

export const pickANameBlurb = Msgs.def(
	'This instance runs without authentication. Whatever you type here is who you are, and anyone else can be them too.',
)

export const usernameLabel = Msgs.def('Username')

export const continueLabel = Msgs.def('Continue')

export const accessDeniedHeading = Msgs.def('Access denied')

export const accessDeniedBlurb = Msgs.def(
	'Your Discord account does not have sufficient privileges in {where} to access this site.',
	(guildName: string | null) => ({ where: where(guildName) }),
)

export const backToHome = Msgs.def('Back to home')

export const logOutAndSwitch = Msgs.def('Log out and switch account')

export const accessDeniedContact = Msgs.def('If you believe this is a mistake, contact an administrator.')

// Editing your own profile.

export const nicknameUpdated = Msgs.def(() => ({ toast: () => [Msgs.t('Nickname updated successfully!')] }))

export const nicknameRejected = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Error updating nickname'), { description: reason }],
}))

// the request threw rather than answering, so there is nothing of the server's to quote
export const nicknameUpdateFailed = Msgs.def(() => ({
	toast: () => [Msgs.t('Failed to update nickname'), { description: Msgs.t('An unexpected error occurred') }],
}))

export const steamAccountsUpdated = Msgs.def(() => ({ toast: () => [Msgs.t('Linked Steam accounts updated')] }))

export const steamIdAlreadyLinked = Msgs.def((steamId: string) => ({
	toast: () => [Msgs.t('Steam ID already linked'), { description: Msgs.t('{steamId} is linked to another account.', { steamId }) }],
}))

export const steamUpdateFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Failed to update'), { description: reason }],
}))

export const steamLinkAssigned = Msgs.def((discordName: string) => ({
	toast: () => [Msgs.t('Steam account linked'), { description: Msgs.t('Linked to {discordName}.', { discordName }) }],
}))

export const steamLinkRemoved = Msgs.def(() => ({ toast: () => [Msgs.t('Steam link removed')] }))

// the picker only searches the home guild, so an id typed in by hand is the way to reach this
export const steamLinkNotAGuildMember = Msgs.def((discordId: string) => ({
	toast: () => [
		Msgs.t('Not a member of this Discord'),
		{ description: Msgs.t('{discordId} could not be resolved in the home guild.', { discordId }) },
	],
}))

export const steamLinkFailed = Msgs.def(() => ({ toast: () => [Msgs.t('Failed to update the link')] }))

// One toast for the whole condition, kept alive and updated in place while it holds, so its id, its infinite
// duration and its action handler stay at the call site.
export const otherSessionsActive = Msgs.def((count: number) => ({
	toast: () => [Msgs.t('Other sessions active'), { description: `You're active in ${count} other session${count > 1 ? 's' : ''}.` }],
}))

export const resetOtherSessions = Msgs.def('Reset them')

// -------- a player's discord link --------

export const discordLabel = Msgs.def('Discord')

export const linkedBy = Msgs.def('linked by {admin}', (admin?: string) => ({ admin: admin ?? 'an admin' }))

export const selfLinked = Msgs.def('self-linked')

export const unlink = Msgs.def('Unlink')

// -------- the nickname dialog --------

export const nicknameDialogTitle = Msgs.def('Set Custom Nickname')

export const nicknameDialogBlurb = Msgs.def(
	'Choose a custom nickname that will be displayed instead of your Discord name. Leave empty to use your Discord display name.',
)

export const nicknameFieldLabel = Msgs.def('Nickname')

export const nicknamePlaceholder = Msgs.def('Enter a custom nickname...')

export const nicknamePreview = Msgs.def('Will display as: "{nickname}"', (nickname: string) => ({ nickname }))

export const nicknameFallsBackToDiscord = Msgs.def('Will use Discord display name')

export const nicknameTooLong = Msgs.def('Nickname must be 64 characters or less')

export const save = Msgs.def('Save')

export const saving = Msgs.def('Saving...')

// -------- the linked steam accounts dialog --------

export const steamDialogTitle = Msgs.def('Linked Steam Accounts')

export const steamDialogBlurb = Msgs.def(
	'Link your Steam64 IDs so in-game admin commands (like /kick) recognize you. Add as many as you need. Links an admin made on your behalf are listed here too, and you can remove them.',
)

export const steamIdPlaceholder = Msgs.def('17-digit Steam64 ID')

export const steamLinkedByAdmin = Msgs.def('Linked by {admin}', (admin: string) => ({ admin }))

// -------- the discord role and member pickers --------

export const discordRolePicker = Msgs.def('role')

export const discordRoleUnresolved = Msgs.def(
	'This Discord role no longer exists in the server (its id is shown). Pick another role or remove this assignment.',
)

export const discordMemberPicker = Msgs.def('member')

export const discordMemberPlaceholder = Msgs.def('Search members…')

export const discordMemberSearchPlaceholder = Msgs.def('Search by name or id…')

export const noDiscordMembersFound = Msgs.def('No members found.')

export const searchDiscordMembers = Msgs.def('Type a name or id to search members.')

export const discordMemberUnresolved = Msgs.def(
	"This Discord user isn't a current server member (their id is shown). They may have left the server, or are otherwise unknown.",
)
