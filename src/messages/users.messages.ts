import { def, raw, t } from '@/models/messages.models'

// Delivered as HTTP response bodies, which is the `text` surface rather than any player-facing one.
export const noApplicationAccess = def('You have not been granted access to this application. Please contact an administrator.', () => ({}))

export const unAuthenticated = def('Not able to authenticate user')

// what the no-auth login portal says back when the name posted to it is not one (see fastify.server)
export const invalidUsername = def('Pick a name of 1 to 32 letters, digits, spaces, dots, dashes or underscores.')

// -------- the landing pages --------
// The unauthenticated entry to the app, rendered to static HTML per locale by landing.server.ts. guildName is
// null when the instance does not know which Discord it belongs to, which is what the vaguer wording is for.

function where(guildName: string | null) {
	return guildName ?? t('the configured Discord')
}

// which of the three pages is being rendered. Declared here because the titles are the only thing keyed by it and
// both the component and landing.server.ts were spelling the union out.
export type LandingVariant = 'landing' | 'no-auth' | 'forbidden'

export const landingTitles = {
	landing: def('Squad Layer Manager'),
	'no-auth': def('Sign in - Squad Layer Manager'),
	forbidden: def('Access denied - Squad Layer Manager'),
} satisfies Record<LandingVariant, unknown>

export const landingHeading = def(
	'{named, select, yes {You have reached the SLM instance for {guildName}.} other {You have reached this Squad Layer Manager instance.}}',
	(guildName: string | null) => ({ guildName, named: guildName ? 'yes' : 'no' }),
)

export const landingBlurb = def(
	'To access this site you must sign in with a Discord account that has sufficient privileges in {where}.',
	(guildName: string | null) => ({ where: where(guildName) }),
)

export const logInWithDiscord = def('Log in with Discord')

export const viewOnGithub = def('View on GitHub')

export const pickANameHeading = def('Pick a name')

export const pickANameBlurb = def(
	'This instance runs without authentication. Whatever you type here is who you are, and anyone else can be them too.',
)

export const usernameLabel = def('Username')

export const continueLabel = def('Continue')

export const accessDeniedHeading = def('Access denied')

export const accessDeniedBlurb = def(
	'Your Discord account does not have sufficient privileges in {where} to access this site.',
	(guildName: string | null) => ({ where: where(guildName) }),
)

export const backToHome = def('Back to home')

export const logOutAndSwitch = def('Log out and switch account')

export const accessDeniedContact = def('If you believe this is a mistake, contact an administrator.')

// Editing your own profile.

export const nicknameUpdated = def(() => ({ toast: [t('Nickname updated successfully!')] }))

export const nicknameRejected = def((reason: string) => ({
	toast: [t('Error updating nickname'), { description: raw(reason) }],
}))

// the request threw rather than answering, so there is nothing of the server's to quote
export const nicknameUpdateFailed = def(() => ({
	toast: [t('Failed to update nickname'), { description: t('An unexpected error occurred') }],
}))

export const steamAccountsUpdated = def(() => ({ toast: [t('Linked Steam accounts updated')] }))

export const steamIdAlreadyLinked = def((steamId: string) => ({
	toast: [t('Steam ID already linked'), { description: t('{steamId} is linked to another account.', { steamId }) }],
}))

export const steamUpdateFailed = def((reason: string) => ({
	toast: [t('Failed to update'), { description: raw(reason) }],
}))

export const steamLinkAssigned = def((discordName: string) => ({
	toast: [t('Steam account linked'), { description: t('Linked to {discordName}.', { discordName }) }],
}))

export const steamLinkRemoved = def(() => ({ toast: [t('Steam link removed')] }))

// the picker only searches the home guild, so an id typed in by hand is the way to reach this
export const steamLinkNotAGuildMember = def((discordId: string) => ({
	toast: [t('Not a member of this Discord'), { description: t('{discordId} could not be resolved in the home guild.', { discordId }) }],
}))

export const steamLinkFailed = def(() => ({ toast: [t('Failed to update the link')] }))

// Refuses a change that would hand somebody permissions the caller does not hold. Worded for either direction:
// removing a link takes away exactly what adding it granted, and both take the same standing.
export const steamLinkWouldEscalate = def(() => ({
	toast: [t('Not allowed'), { description: t('This link carries permissions you do not have yourself.') }],
}))

// -------- proving ownership of a steam account in game --------

export const linkCodeInvalid = def('That code is not valid. Codes expire after a few minutes, so start again from the SLM website.')

export const linkCodeSteamTaken = def('This Steam account is already linked to somebody else. An admin has to remove that link first.')

export const linkCodeAccepted = def((discordName: string) => ({
	warn: t('Steam account linked to {discordName}.', { discordName }),
}))

export const linkAccountAction = def('Link a Steam account')

export const linkCodeSendLabel = def('Send this in any in-game chat')

// The website never hears back from the game. The dialog waits on the new link showing up in the list, which the
// rbac invalidation push already drives, so this is all there is to say while it waits.
export const linkCodeWaiting = def('Waiting for you to send it in game...')

export const linkCodeExpiresIn = def('Expires in {time}', (time: string) => ({ time }))

export const linkCodeExpired = def('That code has expired.')

export const linkCodeRetry = def('Get a new code')

export const linkCodeCopy = def('Copy')

export const linkCodeMintFailed = def(() => ({ toast: [t('Could not start linking')] }))

// self-serve additions go through the in-game code now; the endpoint still takes removals
export const steamAddNeedsVerification = def((steamId: string) => ({
	toast: [t('Steam ID must be verified'), { description: t('Link {steamId} by sending a code in game instead.', { steamId }) }],
}))

// One toast for the whole condition, kept alive and updated in place while it holds, so its id, its infinite
// duration and its action handler stay at the call site.
export const otherSessionsActive = def((count: number) => ({
	toast: [
		t('Other sessions active'),
		{ description: t("You're active in {count, plural, one {# other session} other {# other sessions}}.", { count }) },
	],
}))

export const resetOtherSessions = def('Reset them')

// -------- a player's discord link --------

export const discordLabel = def('Discord')

export const linkedBy = def('linked by {admin}', (admin?: string) => ({ admin: admin ?? 'an admin' }))

export const selfLinked = def('self-linked')

export const unlink = def('Unlink')

// -------- the nickname dialog --------

export const nicknameDialogTitle = def('Set Custom Nickname')

export const nicknameDialogBlurb = def(
	'Choose a custom nickname that will be displayed instead of your Discord name. Leave empty to use your Discord display name.',
)

export const nicknameFieldLabel = def('Nickname')

export const nicknamePlaceholder = def('Enter a custom nickname...')

export const nicknamePreview = def('Will display as: "{nickname}"', (nickname: string) => ({ nickname }))

export const nicknameFallsBackToDiscord = def('Will use Discord display name')

export const nicknameTooLong = def('Nickname must be 64 characters or less')

export const save = def('Save')

export const saving = def('Saving...')

// -------- the linked steam accounts dialog --------

export const steamDialogTitle = def('Linked Steam Accounts')

export const steamDialogBlurb = def(
	'Linking a Steam account lets in-game admin commands recognize you. Add as many as you need. Links an admin made on your behalf are listed here too, and you can remove them.',
)

export const steamIdPlaceholder = def('17-digit Steam64 ID')

export const steamLinkedByAdmin = def('Linked by {admin}', (admin: string) => ({ admin }))

// -------- the discord role and member pickers --------

export const discordRolePicker = def('role')

export const discordRoleUnresolved = def(
	'This Discord role no longer exists in the server (its id is shown). Pick another role or remove this assignment.',
)

export const discordMemberPicker = def('member')

export const discordMemberPlaceholder = def('Search members…')

export const discordMemberSearchPlaceholder = def('Search by name or id…')

export const noDiscordMembersFound = def('No members found.')

export const searchDiscordMembers = def('Type a name or id to search members.')

export const discordMemberUnresolved = def(
	"This Discord user isn't a current server member (their id is shown). They may have left the server, or are otherwise unknown.",
)

export const discordChannelPicker = def('channel')

export const discordChannelPickerMulti = def('channels')

export const discordChannelUnresolved = def(
	'This Discord channel is not one SLM can see (its id is shown). It may have been deleted, or the bot may not have access to it.',
)
