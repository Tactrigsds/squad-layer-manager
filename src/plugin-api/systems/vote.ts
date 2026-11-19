/**
 * Starting votes on the managed server, attributed to the calling plugin.
 *
 * A layer vote decides between the choices of a vote item in the queue; create one through slm/systems/layer-queue.
 * A simple vote asks players to pick one of a few text choices and never changes the queue. Players vote by typing a
 * choice's number in chat, so only one vote of either kind runs at a time, and starting one while another runs is
 * refused with `err:vote-in-progress`.
 */
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import * as V from '@/models/vote.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as Vote from '@/systems/vote.server'

export type SimpleVoteState = V.SimpleVote.State

/** The fewest and most choices a simple vote takes, and the longest a choice may be. */
export const SIMPLE_VOTE_LIMITS = {
	minChoices: V.SimpleVote.MIN_CHOICES,
	maxChoices: V.SimpleVote.MAX_CHOICES,
	maxChoiceLength: V.SimpleVote.MAX_CHOICE_LENGTH,
}

export type StartVoteResult = {
	code:
		| 'ok'
		| 'err:vote-in-progress'
		| 'err:vote-not-allowed'
		| 'err:item-not-found'
		| 'err:invalid-item-type'
		| 'err:public-vote-not-first'
		| 'err:editing-in-progress'
		| 'err:rcon'
		| 'err:too-few-choices'
		| 'err:too-many-choices'
		| 'err:choice-too-long'
		| 'err:duplicate-choice'
}

/**
 * Starts a vote of either kind. `{ kind: 'layer', itemId }` starts the layer vote of that vote item in the queue; a public
 * layer vote must be the first item, and is refused in post-game. `{ kind: 'simple', choices }` starts a simple vote
 * between `choices`, in the order given, which must differ ignoring case. An internal vote polls only the admins in game.
 * `duration` (ms) defaults to the vote item's configured duration, and then to the server's.
 */
export async function startVote(ctx: PluginsSys.ServerCtx<any>, opts: V.StartVoteOpts): Promise<StartVoteResult> {
	const res = await Vote.startVote(ctx, { ...opts, initiator: { pluginId: ctx.plugin.id } })
	// the host's results carry english messages, which are not a string to freeze into this contract
	switch (res.code) {
		case 'ok':
		case 'err:vote-in-progress':
		case 'err:vote-not-allowed':
		case 'err:item-not-found':
		case 'err:invalid-item-type':
		case 'err:public-vote-not-first':
		case 'err:editing-in-progress':
		case 'err:rcon':
		case 'err:too-few-choices':
		case 'err:too-many-choices':
		case 'err:choice-too-long':
		case 'err:duplicate-choice':
			return { code: res.code }
		default:
			assertNever(res)
	}
}

/**
 * The server's simple vote: its current state, then every change, including each vote cast. Ended votes stay until the
 * next one starts, so a vote this plugin started can be followed to its result. Wrap it in `durableSub`.
 */
export function simpleVote$(ctx: PluginsSys.ServerCtx<any>): Rx.Observable<SimpleVoteState | null> {
	return Rx.defer(() =>
		ctx.vote.simple.update$.pipe(
			Rx.scan((state: SimpleVoteState | null, update) => V.SimpleVote.applyUpdate(state, update), ctx.vote.simple.state),
			Rx.startWith(ctx.vote.simple.state),
		),
	)
}
