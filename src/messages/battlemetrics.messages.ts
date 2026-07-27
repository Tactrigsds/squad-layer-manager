import * as Msgs from '@/messages/shared'

export const manageFlags = Msgs.def(() => ({
	confirm: () => ({
		title: 'Manage Flags',
		description: "Add or remove BattleMetrics flags on this player's profile.",
		confirmLabel: 'Apply',
	}),
}))

export const addFlags = Msgs.def((targetDescription: string) => ({
	confirm: () => ({
		title: 'Add Flags',
		description: `Add BattleMetrics flags to ${targetDescription}.`,
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
