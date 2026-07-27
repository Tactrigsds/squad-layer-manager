import * as Msgs from '@/messages/shared'
import type * as TSW from '@/models/teamswaps.models'

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

// Why a teamswap op was rejected, keyed by code. A lookup rather than a message: it has no target axis, and it
// deliberately does not cover every rejection -- the codes it omits are the ones the user is shown nothing for.
// Only ever read on the originating client, so it is written to whoever tried.
export const rejectionTexts: Partial<Record<TSW.Rejection['code'], Msgs.ToastArgs>> = {
	'err:currently-swapping': ['Swap in progress', { description: 'Cannot modify swaps while a team swap is being executed.' }],
	'err:swaps-not-saved': ['Swaps not saved', { description: 'Save your swaps before executing.' }],
	'err:pending-swap': ['Player swap pending', { description: 'A swap for this player is already pending execution.' }],
	'err:nothing-queued': ['No teamswaps queued', { description: 'There is nothing to clear.' }],
	'err:currently-not-swapping': ['Unexpected error', { description: 'An unexpected error occurred with the team swap system.' }],
	'err:unexpected': ['Unexpected error', { description: 'An unexpected error occurred with the team swap system.' }],
}

export const saved = Msgs.def((name: string, count: number) => ({
	toast: () => [
		'Teamswaps saved',
		{ description: count > 0 ? `${name} saved ${count} teamswap${count !== 1 ? 's' : ''}.` : `${name} cleared the saved teamswaps.` },
	],
}))

// the cancellation is part of the message because it is the consequence the admin has to act on
export const executionFailed = Msgs.def((reason: 'not-all-players-swapped' | 'timeout' | (string & {}), playerCount?: number) => {
	const why =
		reason === 'not-all-players-swapped'
			? `${playerCount ?? 0} player${playerCount === 1 ? '' : 's'} could not be swapped to their assigned team.`
			: reason === 'timeout'
				? 'The swap never took effect on the server.'
				: reason
	return { toast: () => ['Team swap failed', { description: `${why} The pending swaps have been cancelled.` }] }
})

// no name means the map roll executed the queue: nobody's action, so nobody is named
export const executed = Msgs.def((swapCount: number, name?: string) => {
	const players = `${swapCount} player${swapCount !== 1 ? 's' : ''}`
	return {
		toast: () => [
			'Teamswaps executed',
			{
				description:
					name === undefined
						? `${players} swapped to their assigned teams on map change.`
						: `${name} swapped ${players} to their assigned teams.`,
			},
		],
	}
})
