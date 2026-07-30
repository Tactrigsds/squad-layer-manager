import { assertNever } from '@/lib/type-guards'
import { t } from '@/models/messages.models'

// Who an admin action is being applied to. The same action is offered on one player, on a selection, and on a squad,
// and the only thing that differs between the three is how the subject is named, so it is a parameter rather than
// three copies of every message.
export type Target =
	| { kind: 'player'; username?: string }
	// fullSquad titles the dialog "... Squad" while still describing the selection as N players, matching the menu
	// item, which reads "Warn Squad" when the selection happens to be exactly one squad's membership
	| { kind: 'players'; count: number; fullSquad?: boolean }
	| { kind: 'squad'; squadName: string; count: number }

// Each of these is interpolated into a sentence, so each returns a target rather than a string: the name is
// translated with the sentence around it, and a count carries its own plural rule. A username is a proper noun and
// stays the string it is.

// names the target in a dialog title: "Kill <this>"
export function noun(target: Target) {
	switch (target.kind) {
		case 'player':
			return t('Player')
		case 'players':
			return target.fullSquad ? t('Squad') : t('Players')
		case 'squad':
			return t('Squad')
		default:
			assertNever(target)
	}
}

// names the target inside a question: "Kill <this>?"
export function subject(target: Target) {
	switch (target.kind) {
		case 'player':
			return target.username ?? t('this player')
		case 'players':
			return t('{count, plural, one {this player} other {these # players}}', { count: target.count })
		case 'squad':
			return t('the {count, plural, one {# member} other {# members}} of squad "{squadName}"', {
				count: target.count,
				squadName: target.squadName,
			})
		default:
			assertNever(target)
	}
}

// names the target inside a report of what happened: "Killed <this>"
export function affected(target: Target) {
	switch (target.kind) {
		case 'player':
			return target.username ?? t('player')
		case 'players':
			return t('{count, plural, one {# player} other {# players}}', { count: target.count })
		case 'squad':
			return t('squad "{squadName}"', { squadName: target.squadName })
		default:
			assertNever(target)
	}
}
