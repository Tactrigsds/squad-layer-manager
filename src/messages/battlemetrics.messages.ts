import * as Msgs from '@/messages/shared'

export const manageFlags = Msgs.def(() => ({
	confirm: () => ({
		title: 'Manage Flags',
		description: "Add or remove BattleMetrics flags on this player's profile.",
		confirmLabel: 'Apply',
	}),
}))

export const addFlags = Msgs.def((target: Msgs.Target) => ({
	confirm: () => ({
		title: 'Add Flags',
		description: `Add BattleMetrics flags to ${Msgs.targetSubject(target)}.`,
		confirmLabel: 'Apply',
	}),
}))

export const noChanges = Msgs.def(() => ({ toast: () => ['No changes to apply'] }))

export const noFlagsToAdd = Msgs.def(() => ({ toast: () => ['No flags to add'] }))

export const reasonRequired = Msgs.def((flags: string[]) => ({
	toast: () => ['Reason required', { description: `These flags require a reason: ${flags.join(', ')}` }],
}))

// code rather than a sentence: the failures here are transport and BattleMetrics API problems, and the code is
// what an admin would quote when reporting one
export const updateFailed = Msgs.def((code: string) => ({
	toast: () => ['Failed to update flags', { description: code }],
}))

export const addFailed = Msgs.def((code: string) => ({
	toast: () => ['Failed to add flags', { description: code }],
}))

// the note is a separate BattleMetrics call, so the flags can land while it does not; saying so is the difference
// between "it worked" and "it worked, but check the profile"
export const flagsUpdated = Msgs.def((added: { name: string }[], removed: { name: string }[], noteAdded: boolean) => {
	const summary = [...added.map((f) => `+${f.name}`), ...removed.map((f) => `−${f.name}`)].join(', ')
	return {
		toast: () => [
			`Updated flags: ${summary}`,
			{ description: noteAdded ? undefined : 'The flags were updated, but a BattleMetrics note failed to post.' },
		],
	}
})

export const flagsAdded = Msgs.def((flaggedCount: number, playerCount: number, noteAdded: boolean) => ({
	toast: () => [
		`Flagged ${flaggedCount} of ${playerCount} players`,
		{ description: noteAdded ? undefined : 'The flags were added, but a BattleMetrics note failed to post.' },
	],
}))

export const refreshFailed = Msgs.def(() => ({ toast: () => ['Failed to refresh BattleMetrics data'] }))

// -------- a player's BM sidebar --------

export const hoursPlayedHint = Msgs.def("Hours played on this org's servers")

export const hoursPlayed = Msgs.def((hours: number) => `${hours}h`)

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

export const reasonsBecomeNotes = Msgs.def((scope: 'player' | 'selection') =>
	scope === 'player'
		? "Each reason is posted to the player's BattleMetrics profile as its own note."
		: "Each reason is posted to every selected player's BattleMetrics profile as its own note.",
)

export const manageFlagsHint = Msgs.def('Manage flags')

export const unknownFlag = Msgs.def('Unknown flag')

export const unknownFlagHint = Msgs.def((id: string) => `Unknown flag: ${id}`)

export const flagPicker = Msgs.def('Flag')
