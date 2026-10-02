import * as Tgt from '@/messages/target'
import { def, raw, t } from '@/models/messages.models'

export const manageFlags = def(() => ({
	confirm: {
		title: t('Manage Flags'),
		description: t("Add or remove BattleMetrics flags on this player's profile."),
		confirmLabel: t('Apply'),
	},
}))

export const addFlags = def((target: Tgt.Target) => ({
	confirm: {
		title: t('Add Flags'),
		description: t('Add BattleMetrics flags to {targetSubject}.', { targetSubject: Tgt.subject(target) }),
		confirmLabel: t('Apply'),
	},
}))

export const noChanges = def(() => ({ toast: [t('No changes to apply')] }))

export const noFlagsToAdd = def(() => ({ toast: [t('No flags to add')] }))

export const reasonRequired = def((flags: string[]) => ({
	toast: [t('Reason required'), { description: t('These flags require a reason: {join}', { join: flags.join(', ') }) }],
}))

// code rather than a sentence: the failures here are transport and BattleMetrics API problems, and the code is
// what an admin would quote when reporting one
export const updateFailed = def((code: string) => ({
	toast: [t('Failed to update flags'), { description: raw(code) }],
}))

export const addFailed = def((code: string) => ({
	toast: [t('Failed to add flags'), { description: raw(code) }],
}))

export const personalTokenRejected = def(() => ({
	toast: [
		t('BattleMetrics rejected your personal token'),
		{
			description: t(
				'The token may be revoked or expired, or it may lack a scope it needs. Replace it from BattleMetrics Token in the user menu.',
			),
		},
	],
}))

// the note is a separate BattleMetrics call, so the flags can land while it does not; saying so is the difference
// between "it worked" and "it worked, but check the profile"
export const flagsUpdated = def((added: { name: string }[], removed: { name: string }[], noteAdded: boolean) => {
	const summary = [...added.map((f) => `+${f.name}`), ...removed.map((f) => `−${f.name}`)].join(', ')
	return {
		toast: [
			t('Updated flags: {summary}', { summary }),
			{ description: noteAdded ? undefined : t('The flags were updated, but a BattleMetrics note failed to post.') },
		],
	}
})

export const flagsAdded = def((flaggedCount: number, playerCount: number, noteAdded: boolean) => ({
	toast: [
		t('Flagged {flaggedCount} of {playerCount} players', { flaggedCount, playerCount }),
		{ description: noteAdded ? undefined : t('The flags were added, but a BattleMetrics note failed to post.') },
	],
}))

export const refreshFailed = def(() => ({ toast: [t('Failed to refresh BattleMetrics data')] }))

// -------- a player's BM sidebar --------

export const hoursPlayedHint = def("Hours played on this org's servers")

export const hoursPlayed = def('{hours}h', (hours: number) => ({ hours }))

export const refreshHint = def('Refresh BattleMetrics data')

export const showAllFlags = def('Show all tags')

// -------- the add/manage flag dialogs --------

export const keepFlag = def('Keep this flag')

export const dontAddFlag = def("Don't add this flag")

export const removeFlag = def('Remove this flag')

export const whyRemoving = def('Why is this flag being removed?')

// what the pending save will do to a flag row
export const flagRowChange = def('{change, select, adding {Adding} other {Removing}}', (change: 'adding' | 'removing') => ({ change }))

export const whyApplying = def('Why is this flag being applied?')

export const flagsLabel = def('Flags')

export const noFlags = def('This player has no flags.')

export const flagsToAdd = def('Flags to add')

export const noFlagsSelected = def('No flags selected yet.')

export const selectFlag = def('Select a flag...')

export const addFlag = def('Add flag')

export const hasEveryFlag = def('This player already has every flag in the organization')

export const reasonsBecomeNotes = def(
	"Each reason is posted to {scope, select, player {the player's} other {every selected player's}} BattleMetrics profile as its own note.",
	(scope: 'player' | 'selection') => ({ scope }),
)

export const manageFlagsHint = def('Manage flags')

export const unknownFlag = def('Unknown flag')

export const unknownFlagHint = def('Unknown flag: {id}', (id: string) => ({ id }))

export const flagPicker = def('Flag')

export const selectFlags = def('Select flags...')

export const manageFlagsItem = def('Manage Flags...')

export const addFlagsItem = def('Add Flags...')

// -------- notes --------

export const addNote = def((target: Tgt.Target) => ({
	confirm: {
		title:
			target.kind === 'player'
				? t('Add a BattleMetrics note for {targetSubject}', { targetSubject: Tgt.subject(target) })
				: t('Add a BattleMetrics note to {targetSubject}', { targetSubject: Tgt.subject(target) }),
		confirmLabel:
			target.kind === 'player'
				? t('Add Note')
				: t('Add Note to {count, plural, one {# Player} other {# Players}}', { count: target.count }),
	},
}))

export const noteLabel = def('Note')

export const notePlaceholder = def(
	'What should other admins know about {count, plural, one {this player} other {these players}}?',
	(count: number) => ({ count }),
)

export const noteSignature = def('Signed as "{signature}"', (signature: string) => ({ signature }))

export const noteSubmitHint = def('Ctrl + Enter to add')

export const noteAdded = def((notedCount: number, playerCount: number) => ({
	toast: [
		playerCount === 1
			? t('Added a BattleMetrics note')
			: t('Added a note to {notedCount} of {playerCount} players', { notedCount, playerCount }),
	],
}))

export const noteFailed = def((code: string) => ({
	toast: [t('Failed to add the note'), { description: raw(code) }],
}))

export const addNoteHint = def('Add a note')

export const addNoteItem = def('Add Note...')

export const addNoteToSquad = def('Add Note to Squad...')

export const notesLabel = def('BM notes')

export const loadNotes = def('Load notes')

export const reloadNotes = def('Reload notes')

export const hideNotes = def('Hide notes')

export const notesLoading = def('Loading...')

export const notesLoadedAt = def('Loaded {ago}', (ago: string) => ({ ago }))

export const noNotes = def("No notes on this player's BattleMetrics profile.")

export const notesFailed = def("Couldn't load notes from BattleMetrics.")

export const notesNotFound = def("This player wasn't found on BattleMetrics.")

export const retryNotes = def('Try again')

export const allNotesOnBm = def('All notes on BattleMetrics')

export const notesTruncated = def('Showing the first {count} notes.', (count: number) => ({ count }))

export const noteFlagChange = def(
	'{action, select, added {Added} other {Removed}} flag "{flag}"',
	(action: 'added' | 'removed', flag: string) => ({ action, flag }),
)

export const noteSourceSlm = def('SLM')

export const noteSourceBm = def('BattleMetrics')

export const unknownBmUser = def('Unknown user')

// -------- personal token --------

export const tokenMenuItem = def('BattleMetrics Token')

export const tokenDialogTitle = def('BattleMetrics Token')

export const tokenDialogBlurb = def(
	'Save a BattleMetrics personal access token to add and remove flags and post notes as your own BattleMetrics account.',
)

export const tokenCreateLink = def('Create a token on BattleMetrics')

export const tokenScopesHeading = def('Give the token these scopes:')

export const tokenScopeFlags = def('Player flags: add and remove')

export const tokenScopeNotes = def('Player notes: create')

export const tokenSaved = def('Your flag and note changes use the token you saved on {date}.', (date: string) => ({ date }))

export const tokenNotSaved = def("You have not saved a token yet, so your flag and note changes use your organization's token.")

export const tokenFieldLabel = def('Personal access token')

export const tokenFieldPlaceholder = def('Paste a token')

export const tokenFieldReplacePlaceholder = def('Paste a new token to replace the saved one')

export const tokenRejected = def(
	'BattleMetrics rejected this token. Check that the whole token was copied and that it has the scopes listed above.',
)

export const tokenCheckFailed = def('SLM could not reach BattleMetrics to check the token. Try again.')

export const tokenSave = def('Save')

export const tokenRemove = def('Remove')

export const tokenSavedToast = def(() => ({ toast: [t('BattleMetrics token saved')] }))

export const tokenRemovedToast = def(() => ({ toast: [t('BattleMetrics token removed')] }))

export const tokenRemoveFailed = def(() => ({ toast: [t('Failed to remove the BattleMetrics token')] }))

export const tokenLinkSteamHeading = def('Link your Steam account')

export const tokenLinkSteamBlurb = def(
	'Flag and note changes you make on this website now use your token. In-game flag and note commands use it only when SLM knows the Steam account you send them from. Link that Steam account to use your token in game too.',
)

export const tokenLinkSteamAction = def('Link a Steam account')

export const tokenLinkSteamLater = def('Not now')
