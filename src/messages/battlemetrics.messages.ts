import * as Msgs from '@/messages/shared'

export const manageFlags = Msgs.def(() => ({
	confirm: () => ({
		title: Msgs.t('Manage Flags'),
		description: Msgs.t("Add or remove BattleMetrics flags on this player's profile."),
		confirmLabel: Msgs.t('Apply'),
	}),
}))

export const addFlags = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: Msgs.t('Add Flags'),
		description: Msgs.t('Add BattleMetrics flags to {targetSubject}.', { targetSubject: Msgs.targetSubject(target) }),
		confirmLabel: Msgs.t('Apply'),
	}),
}))

export const noChanges = Msgs.def(() => ({ toast: () => [Msgs.t('No changes to apply')] }))

export const noFlagsToAdd = Msgs.def(() => ({ toast: () => [Msgs.t('No flags to add')] }))

export const reasonRequired = Msgs.def((flags: string[]) => ({
	toast: () => [Msgs.t('Reason required'), { description: Msgs.t('These flags require a reason: {join}', { join: flags.join(', ') }) }],
}))

// code rather than a sentence: the failures here are transport and BattleMetrics API problems, and the code is
// what an admin would quote when reporting one
export const updateFailed = Msgs.def((code: string) => ({
	toast: () => [Msgs.t('Failed to update flags'), { description: code }],
}))

export const addFailed = Msgs.def((code: string) => ({
	toast: () => [Msgs.t('Failed to add flags'), { description: code }],
}))

// the note is a separate BattleMetrics call, so the flags can land while it does not; saying so is the difference
// between "it worked" and "it worked, but check the profile"
export const flagsUpdated = Msgs.def((added: { name: string }[], removed: { name: string }[], noteAdded: boolean) => {
	const summary = [...added.map((f) => `+${f.name}`), ...removed.map((f) => `−${f.name}`)].join(', ')
	return {
		toast: () => [
			Msgs.t('Updated flags: {summary}', { summary }),
			{ description: noteAdded ? undefined : 'The flags were updated, but a BattleMetrics note failed to post.' },
		],
	}
})

export const flagsAdded = Msgs.def((flaggedCount: number, playerCount: number, noteAdded: boolean) => ({
	toast: () => [
		Msgs.t('Flagged {flaggedCount} of {playerCount} players', { flaggedCount, playerCount }),
		{ description: noteAdded ? undefined : 'The flags were added, but a BattleMetrics note failed to post.' },
	],
}))

export const refreshFailed = Msgs.def(() => ({ toast: () => [Msgs.t('Failed to refresh BattleMetrics data')] }))

// -------- a player's BM sidebar --------

export const hoursPlayedHint = Msgs.def("Hours played on this org's servers")

export const hoursPlayed = Msgs.def('{hours}h', (hours: number) => ({ hours }))

export const refreshHint = Msgs.def('Refresh BattleMetrics data')

export const showAllFlags = Msgs.def('Show all tags')

// -------- the add/manage flag dialogs --------

export const keepFlag = Msgs.def('Keep this flag')

export const dontAddFlag = Msgs.def("Don't add this flag")

export const removeFlag = Msgs.def('Remove this flag')

export const whyRemoving = Msgs.def('Why is this flag being removed?')

export const whyApplying = Msgs.def('Why is this flag being applied?')

export const flagsLabel = Msgs.def('Flags')

export const noFlags = Msgs.def('This player has no flags.')

export const flagsToAdd = Msgs.def('Flags to add')

export const noFlagsSelected = Msgs.def('No flags selected yet.')

export const selectFlag = Msgs.def('Select a flag...')

export const addFlag = Msgs.def('Add flag')

export const hasEveryFlag = Msgs.def('This player already has every flag in the organization')

export const reasonsBecomeNotes = Msgs.def(
	"Each reason is posted to {scope, select, player {the player's} other {every selected player's}} BattleMetrics profile as its own note.",
	(scope: 'player' | 'selection') => ({ scope }),
)

export const manageFlagsHint = Msgs.def('Manage flags')

export const unknownFlag = Msgs.def('Unknown flag')

export const unknownFlagHint = Msgs.def('Unknown flag: {id}', (id: string) => ({ id }))

export const flagPicker = Msgs.def('Flag')
