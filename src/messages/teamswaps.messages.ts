import type * as Msgs from '@/messages/shared'

export const WARNS = {
	notifyPlayerOfUpcomingTeamswap:
		'You have been marked for a team swap on mapchange. ' +
		'Thank you for helping with team balance and contact admins if you have issues.',
	notifyTeamswapCancelled: 'You will no longer be swapped to the other team on map roll.',
	notifyManualSwap: 'You have been swapped to the other team by an admin.',
	// added/removed are the real per-player diff against the previously saved swaps, not the net change in
	// size: a save that adds 3 and removes 1 is not "added 2"
	notifyAdminSwapsSaved: (name: string, count: number, added: number, removed: number, factionLines?: string[]) => {
		if (count === 0) return `${name} cleared all queued teamswaps for next map.`
		const parts: string[] = []
		if (added > 0) parts.push(`added ${added}`)
		if (removed > 0) parts.push(`removed ${removed}`)
		const changeSummary = parts.length > 0 ? ` (${parts.join(', ')})` : ''
		const base = `${name} queued ${count} teamswap${count !== 1 ? 's' : ''} for next map${changeSummary}`
		return factionLines?.length ? `${base}:\n${factionLines.join('\n')}` : `${base}.`
	},
	notifyAdminManualSwap: (name: string, count: number, factionLines?: string[]) =>
		factionLines?.length
			? `${name} swapped ${count} player${count !== 1 ? 's' : ''}:\n${factionLines.join('\n')}`
			: `${name} swapped ${count} player${count !== 1 ? 's' : ''} to the other team.`,
} satisfies Msgs.WarnNode
