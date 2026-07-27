// The server imports this module, and its build transpiles JSX with the classic runtime, so React has to be in
// scope here even though the client's automatic runtime would not need it (same bargain as landing-pages.tsx).
import * as React from 'react'

import * as Msgs from '@/messages/shared'
import type * as TSW from '@/models/teamswaps.models'

// -------- the help window --------
// The emphasised words name controls the reader has to find on screen, so which words they are is part of the
// prose. How a highlighted word looks is not: the window styles `strong` itself.

export const helpTitle = Msgs.def('Team Swaps Help')

export const helpIntro = Msgs.def('Queue players to be moved to the opposite team, either at the start of the next round or immediately.')

export const helpStepQueue = Msgs.def(() => ({
	react: () => Msgs.node('Right-click a player and choose <strong>Swap Next</strong> to queue them.', { ...Msgs.tags }),
}))

export const helpStepSave = Msgs.def(() => ({
	react: () =>
		Msgs.node(
			'Click <strong>Save</strong> to commit your queue. Players are notified in-game that they will be swapped at the start of the next round.',
			{ ...Msgs.tags },
		),
}))

export const helpStepSwapNow = Msgs.def(() => ({
	react: () => Msgs.node('Click <strong>Swap Now</strong> to immediately execute all saved swaps.', { ...Msgs.tags }),
}))

export const helpRevert = Msgs.def(() => ({
	react: () => Msgs.node('<strong>Revert</strong> discards unsaved edits back to the last saved state.', { ...Msgs.tags }),
}))

export const helpClearTeam = Msgs.def(() => ({
	react: () => Msgs.node('The <strong>trash icon</strong> on a team column clears all for that team.', { ...Msgs.tags }),
}))

export const notifyPlayerOfUpcomingTeamswap = Msgs.def(() => ({
	warn: (locale?: string) =>
		Msgs.t(
			'You have been marked for a team swap on mapchange. Thank you for helping with team balance and contact admins if you have issues.',
			undefined,
			locale,
		),
}))

export const notifyTeamswapCancelled = Msgs.def(() => ({
	warn: (locale?: string) => Msgs.t('You will no longer be swapped to the other team on map roll.', undefined, locale),
}))

export const notifyManualSwap = Msgs.def(() => ({
	warn: (locale?: string) => Msgs.t('You have been swapped to the other team by an admin.', undefined, locale),
}))

// otherTeam is named only when swapping a single player, where the destination is unambiguous; a selection or a
// squad can span both teams, so each member goes to whichever team they are not on
export const swapNow = Msgs.def((target: Msgs.Target, otherTeam?: string) => ({
	confirm: () => ({
		title: Msgs.t('Swap {targetNoun} Now', { targetNoun: Msgs.targetNoun(target) }),
		description: `Move ${Msgs.targetSubject(target)} to ${otherTeam === undefined ? 'the opposite team' : `Team ${otherTeam}`} immediately?`,
		confirmLabel: Msgs.t('Swap Now'),
	}),
}))

// the confirmation auto-dismisses when a target changes teams while it is open, since the swap would no longer do
// what the admin asked for
export const swapCancelled = Msgs.def((target: Msgs.Target) => ({
	toast: () => [
		Msgs.t('Swap cancelled'),
		{ description: target.kind === 'player' ? 'Player changed teams' : 'One or more players changed teams' },
	],
}))

// the players a swap sends to one team. Named by faction rather than by team id, since that is what the reader
// sees in game.
type SwapGroup = { faction: string; names: string[] }

const swapGroupLine = (group: SwapGroup, locale?: string) =>
	Msgs.t('to {faction}: {names}', { faction: group.faction, names: group.names.join(', ') }, locale)

// what a save did, never what the queue happens to hold: added/removed are the real per-player diff against the
// previously saved swaps (a save that adds 3 and removes 1 is not "added 2"), and the players named are only the
// ones it changed. `queued` is the whole resulting queue, reported as counts at the end so that the standing
// swaps of everyone else are not read as this admin's doing.
export const notifyAdminSwapsSaved = Msgs.def(
	(
		name: string,
		change: { added: number; removed: number; addedGroups?: SwapGroup[]; removedGroups?: SwapGroup[] },
		queued: SwapGroup[],
	) => {
		// a sentence per case rather than one pattern branching three ways, so a translator is handed sentences.
		// the colon is the pattern's because it belongs to the reading, and only the cases that list names take one
		const headline = (listsNames: boolean, locale?: string) => {
			const colon = listsNames ? 'yes' : 'no'
			if (change.added > 0 && change.removed > 0) {
				return Msgs.t(
					'{name} queued {added, plural, one {# teamswap} other {# teamswaps}} and cancelled {removed}{colon, select, yes {:} other {}}',
					{ name, added: change.added, removed: change.removed, colon },
					locale,
				)
			}
			if (change.added > 0) {
				return Msgs.t(
					'{name} queued {added, plural, one {# teamswap} other {# teamswaps}}{colon, select, yes {:} other {}}',
					{ name, added: change.added, colon },
					locale,
				)
			}
			return Msgs.t(
				'{name} cancelled {removed, plural, one {# teamswap} other {# teamswaps}}{colon, select, yes {:} other {}}',
				{ name, removed: change.removed, colon },
				locale,
			)
		}
		return {
			warn: (locale?: string) => {
				const total = queued.reduce((count, group) => count + group.names.length, 0)
				if (total === 0) return Msgs.t('{name} cleared all queued teamswaps for next map.', { name }, locale)
				const named = [
					...(change.addedGroups ?? []).map((group) => swapGroupLine(group, locale)),
					...(change.removedGroups ?? []).map((group) =>
						Msgs.t('no longer to {faction}: {names}', { faction: group.faction, names: group.names.join(', ') }, locale),
					),
				]
				const totals = queued
					.map((group) => Msgs.t('{count} to {faction}', { count: group.names.length, faction: group.faction }, locale))
					.join(', ')
				return [headline(named.length > 0, locale), ...named, Msgs.t('now queued for next map: {totals}', { totals }, locale)].join(
					'\n',
				)
			},
		}
	},
)

export const notifyAdminManualSwap = Msgs.def((name: string, count: number, swapped?: SwapGroup[]) => ({
	warn: (locale?: string) =>
		swapped?.length
			? Msgs.t('{name} swapped {count, plural, one {# player} other {# players}}:', { name, count }, locale) +
				'\n' +
				swapped.map((group) => swapGroupLine(group, locale)).join('\n')
			: Msgs.t('{name} swapped {count, plural, one {# player} other {# players}} to the other team.', { name, count }, locale),
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
		Msgs.t('Teamswaps saved'),
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
	return { toast: () => [Msgs.t('Team swap failed'), { description: Msgs.t('{why} The pending swaps have been cancelled.', { why }) }] }
})

// no name means the map roll executed the queue: nobody's action, so nobody is named
export const executed = Msgs.def((swapCount: number, name?: string) => {
	const players = `${swapCount} player${swapCount !== 1 ? 's' : ''}`
	return {
		toast: () => [
			Msgs.t('Teamswaps executed'),
			{
				description:
					name === undefined
						? `${players} swapped to their assigned teams on map change.`
						: `${name} swapped ${players} to their assigned teams.`,
			},
		],
	}
})
