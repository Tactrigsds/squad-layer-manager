// The server imports this module, and its build transpiles JSX with the classic runtime, so React has to be in
// scope here even though the client's automatic runtime would not need it (same bargain as landing-pages.tsx).
import * as React from 'react'

import * as Tgt from '@/messages/target'
import type * as MH from '@/models/match-history.models'
import { def, join, raw, rt, t, type TString, type Variants } from '@/models/messages.models'
import type * as TSW from '@/models/teamswaps.models'

// -------- the help window --------
// The emphasised words name controls the reader has to find on screen, so which words they are is part of the
// prose. How a highlighted word looks is not: the window styles `strong` itself.

export const helpTitle = def('Team Swaps Help')

export const helpIntro = def('Queue players to be moved to the opposite team, either at the start of the next round or immediately.')

export const helpStepQueue = def(rt('Right-click a player and choose <strong>Swap Next</strong> to queue them.'))

export const helpStepSave = def(
	rt(
		'Click <strong>Save</strong> to commit your queue. Players are notified in-game that they will be swapped at the start of the next round.',
	),
)

export const helpStepSwapNow = def(rt('Click <strong>Swap Now</strong> to immediately execute all saved swaps.'))

export const helpRevert = def(rt('<strong>Revert</strong> discards unsaved edits back to the last saved state.'))

export const helpClearTeam = def(rt('The <strong>trash icon</strong> on a team column clears all for that team.'))

export const notifyPlayerOfUpcomingTeamswap = def(
	'You have been marked for a team swap on mapchange. Thank you for helping with team balance and contact admins if you have issues.',
)

export const notifyTeamswapCancelled = def('You will no longer be swapped to the other team on map roll.')

export const notifyManualSwap = def('You have been swapped to the other team by an admin.')

// The team a swap sends players to, named by its faction, since that is what the reader sees in game. The
// normalized id is only the fallback for a layer whose factions we could not read.
export function destination(team: MH.NormedTeamId, faction?: string | null): TString {
	return faction ? raw(faction) : t('Team {team}', { team })
}

// the destination is named only when swapping a single player, where it is unambiguous; a selection or a squad can
// span both teams, so each member goes to whichever team they are not on
export const swapNow = def((target: Tgt.Target, toTeam?: TString) => ({
	confirm: {
		title: t('Swap {targetNoun} Now', { targetNoun: Tgt.noun(target) }),
		description:
			toTeam === undefined
				? t('Move {subject} to the opposite team immediately?', { subject: Tgt.subject(target) })
				: t('Move {subject} to {toTeam} immediately?', { subject: Tgt.subject(target), toTeam }),
		confirmLabel: t('Swap Now'),
	},
}))

// the confirmation auto-dismisses when a target changes teams while it is open, since the swap would no longer do
// what the admin asked for
export const swapCancelled = def((target: Tgt.Target) => ({
	toast: [
		t('Swap cancelled'),
		{ description: target.kind === 'player' ? t('Player changed teams') : t('One or more players changed teams') },
	],
}))

// the players a swap sends to one team, that team named by `destination`
type SwapGroup = { faction: TString; names: string[] }

const swapGroupLine = (group: SwapGroup) => t('to {faction}: {names}', { faction: group.faction, names: group.names.join(', ') })

// what a save did, never what the queue happens to hold: added/removed are the real per-player diff against the
// previously saved swaps (a save that adds 3 and removes 1 is not "added 2"), and the players named are only the
// ones it changed. `queued` is the whole resulting queue, reported as counts at the end so that the standing
// swaps of everyone else are not read as this admin's doing.
export const notifyAdminSwapsSaved = def(
	(
		name: string,
		change: { added: number; removed: number; addedGroups?: SwapGroup[]; removedGroups?: SwapGroup[] },
		queued: SwapGroup[],
	) => {
		// a sentence per case rather than one pattern branching three ways, so a translator is handed sentences.
		// the colon is the pattern's because it belongs to the reading, and only the cases that list names take one
		const headline = (listsNames: boolean) => {
			const colon = listsNames ? 'yes' : 'no'
			if (change.added > 0 && change.removed > 0) {
				return t(
					'{name} queued {added, plural, one {# teamswap} other {# teamswaps}} and cancelled {removed}{colon, select, yes {:} other {}}',
					{ name, added: change.added, removed: change.removed, colon },
				)
			}
			if (change.added > 0) {
				return t('{name} queued {added, plural, one {# teamswap} other {# teamswaps}}{colon, select, yes {:} other {}}', {
					name,
					added: change.added,
					colon,
				})
			}
			return t('{name} cancelled {removed, plural, one {# teamswap} other {# teamswaps}}{colon, select, yes {:} other {}}', {
				name,
				removed: change.removed,
				colon,
			})
		}
		const total = queued.reduce((count, group) => count + group.names.length, 0)
		if (total === 0) return { warn: t('{name} cleared all queued teamswaps for next map.', { name }) }
		const named = [
			...(change.addedGroups ?? []).map(swapGroupLine),
			...(change.removedGroups ?? []).map((group) =>
				t('no longer to {faction}: {names}', { faction: group.faction, names: group.names.join(', ') }),
			),
		]
		const totals = join(
			queued.map((group) => t('{count} to {faction}', { count: group.names.length, faction: group.faction })),
			', ',
		)
		return {
			warn: join([headline(named.length > 0), ...named, t('now queued for next map: {totals}', { totals })]),
		}
	},
)

export const notifyAdminManualSwap = def((name: string, count: number, swapped?: SwapGroup[]) => ({
	warn: swapped?.length
		? join([t('{name} swapped {count, plural, one {# player} other {# players}}:', { name, count }), ...swapped.map(swapGroupLine)])
		: t('{name} swapped {count, plural, one {# player} other {# players}} to the other team.', { name, count }),
}))

// Why a teamswap op was rejected, keyed by code. A lookup rather than a message: it has no target axis, and it
// deliberately does not cover every rejection -- the codes it omits are the ones the user is shown nothing for.
// Only ever read on the originating client, so it is written to whoever tried.
export const rejections: Partial<Record<TSW.Rejection['code'], () => Variants.Toastable<never>>> = {
	'err:currently-swapping': def({
		toast: [t('Swap in progress'), { description: t('Cannot modify swaps while a team swap is being executed.') }],
	}),
	'err:swaps-not-saved': def({ toast: [t('Swaps not saved'), { description: t('Save your swaps before executing.') }] }),
	'err:pending-swap': def({
		toast: [t('Player swap pending'), { description: t('A swap for this player is already pending execution.') }],
	}),
	'err:nothing-queued': def({ toast: [t('No teamswaps queued'), { description: t('There is nothing to clear.') }] }),
	'err:currently-not-swapping': def({
		toast: [t('Unexpected error'), { description: t('An unexpected error occurred with the team swap system.') }],
	}),
	'err:unexpected': def({ toast: [t('Unexpected error'), { description: t('An unexpected error occurred with the team swap system.') }] }),
}

export const saved = def((name: string, count: number) => ({
	toast: [
		t('Teamswaps saved'),
		{
			description:
				count > 0
					? t('{name} saved {count, plural, one {# teamswap} other {# teamswaps}}.', { name, count })
					: t('{name} cleared the saved teamswaps.', { name }),
		},
	],
}))

// the cancellation is part of the message because it is the consequence the admin has to act on
export const executionFailed = def((reason: 'not-all-players-swapped' | 'timeout' | (string & {}), playerCount?: number) => {
	const why =
		reason === 'not-all-players-swapped'
			? t('{count, plural, one {# player} other {# players}} could not be swapped to their assigned team.', { count: playerCount ?? 0 })
			: reason === 'timeout'
				? t('The swap never took effect on the server.')
				: raw(reason)
	return { toast: [t('Team swap failed'), { description: t('{why} The pending swaps have been cancelled.', { why }) }] }
})

// no name means the map roll executed the queue: nobody's action, so nobody is named
export const executed = def((swapCount: number, name?: string) => {
	return {
		toast: [
			t('Teamswaps executed'),
			{
				description:
					name === undefined
						? t('{count, plural, one {# player} other {# players}} swapped to their assigned teams on map change.', {
								count: swapCount,
							})
						: t('{name} swapped {count, plural, one {# player} other {# players}} to their assigned teams.', {
								name,
								count: swapCount,
							}),
			},
		],
	}
})
