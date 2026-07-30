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
