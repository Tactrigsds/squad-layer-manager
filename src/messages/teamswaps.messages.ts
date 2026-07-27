import * as Msgs from '@/messages/shared'

export const notifyPlayerOfUpcomingTeamswap = Msgs.def(() => ({
	warn: () =>
		'You have been marked for a team swap on mapchange. ' +
		'Thank you for helping with team balance and contact admins if you have issues.',
}))

export const notifyTeamswapCancelled = Msgs.def(() => ({
	warn: () => 'You will no longer be swapped to the other team on map roll.',
}))

export const notifyManualSwap = Msgs.def(() => ({
	warn: () => 'You have been swapped to the other team by an admin.',
}))

// otherTeam is named only when swapping a single player, where the destination is unambiguous; a selection or a
// squad can span both teams, so each member goes to whichever team they are not on
export const swapNow = Msgs.def((target: Msgs.Target, otherTeam?: string) => ({
	confirm: () => ({
		title: `Swap ${Msgs.targetNoun(target)} Now`,
		description: `Move ${Msgs.targetSubject(target)} to ${otherTeam === undefined ? 'the opposite team' : `Team ${otherTeam}`} immediately?`,
		confirmLabel: 'Swap Now',
	}),
}))

// the confirmation auto-dismisses when a target changes teams while it is open, since the swap would no longer do
// what the admin asked for
export const swapCancelled = Msgs.def((target: Msgs.Target) => ({
	toast: () => [
		'Swap cancelled',
		{ description: target.kind === 'player' ? 'Player changed teams' : 'One or more players changed teams' },
	],
}))

// added/removed are the real per-player diff against the previously saved swaps, not the net change in
// size: a save that adds 3 and removes 1 is not "added 2"
export const notifyAdminSwapsSaved = Msgs.def((name: string, count: number, added: number, removed: number, factionLines?: string[]) => ({
	warn: () => {
		if (count === 0) return `${name} cleared all queued teamswaps for next map.`
		const parts: string[] = []
		if (added > 0) parts.push(`added ${added}`)
		if (removed > 0) parts.push(`removed ${removed}`)
		const changeSummary = parts.length > 0 ? ` (${parts.join(', ')})` : ''
		const base = `${name} queued ${count} teamswap${count !== 1 ? 's' : ''} for next map${changeSummary}`
		return factionLines?.length ? `${base}:\n${factionLines.join('\n')}` : `${base}.`
	},
}))

export const notifyAdminManualSwap = Msgs.def((name: string, count: number, factionLines?: string[]) => ({
	warn: () =>
		factionLines?.length
			? `${name} swapped ${count} player${count !== 1 ? 's' : ''}:\n${factionLines.join('\n')}`
			: `${name} swapped ${count} player${count !== 1 ? 's' : ''} to the other team.`,
}))
