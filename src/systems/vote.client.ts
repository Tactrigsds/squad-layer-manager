import type * as Cleanup from '@/lib/cleanup'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import * as V_Msgs from '@/messages/vote.messages'
import * as V from '@/models/vote.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'

// casts arrive as deltas against the state before them, so the state is folded on the stream that receives them in
// order, before the binding that shares it
const voteStateCold$ = (serverId: string) =>
	RPC.observe('vote.watchUpdates', () => RPC.orpc.vote.watchUpdates.call({ serverId })).pipe(
		RPC.dropUnavailable(),
		Rx.tap((update) => {
			if (update.code === 'initial-state' && update.state) {
				PartsSys.stripParts(update.state)
			} else if (update.code === 'update' && !V.isVoteCastUpdate(update.update)) {
				PartsSys.stripParts(update.update)
			}
		}),
		Rx.scan(
			(acc: { update: V.VoteStateUpdateOrInitialWithParts | null; state: V.VoteState | null }, update) => {
				if (update.code === 'initial-state') return { update, state: update.state }
				const next = update.update
				return { update, state: V.isVoteCastUpdate(next) ? V.applyVoteCast(acc.state, next.cast) : next.state }
			},
			{ update: null, state: null },
		),
		Rx.share(),
	)

export const [useVoteStateUpdate, voteStateUpdate$] = ReactRx.bindWithDefault((serverId: string) => voteStateCold$(serverId), {
	update: null,
	state: null,
})
export const [useVoteState, voteState$] = ReactRx.bindWithDefault(
	(serverId: string) => voteStateUpdate$(serverId).pipe(Rx.map(({ state }) => state)),
	null,
)

// casts arrive as deltas, folded in order as voteStateCold$ folds them
const [, simpleVoteState$] = ReactRx.bindWithDefault(
	(serverId: string) =>
		RPC.observe('vote.watchSimpleVote', () => RPC.orpc.vote.watchSimpleVote.call({ serverId })).pipe(
			RPC.dropUnavailable(),
			Rx.scan((state: V.SimpleVote.State | null, update) => V.SimpleVote.applyUpdate(state, update), null),
		),
	null,
)

// the simple vote, until its result has been shown for V.SimpleVote.RESULT_SHOWN_MS
export const [useShownSimpleVoteState, shownSimpleVoteState$] = ReactRx.bindWithDefault(
	(serverId: string) =>
		simpleVoteState$(serverId).pipe(
			Rx.switchMap((state) => {
				if (state === null || state.code === 'in-progress') return Rx.of(state)
				const hideIn = state.endedAt + V.SimpleVote.RESULT_SHOWN_MS - Date.now()
				if (hideIn <= 0) return Rx.of(null)
				return Rx.concat(Rx.of(state), Rx.timer(hideIn).pipe(Rx.map(() => null)))
			}),
		),
	null,
)

export function watchServer(serverId: string, cleanup: Cleanup.Tasks) {
	cleanup.push(voteStateUpdate$(serverId).subscribe())
	cleanup.push(voteState$(serverId).subscribe())
	cleanup.push(simpleVoteState$(serverId).subscribe())
	cleanup.push(shownSimpleVoteState$(serverId).subscribe())
}

export namespace Actions {
	// resolves true once the vote has started, so a caller can clear what it was typed into
	export async function startVote(serverId: string, opts: V.StartVoteOpts): Promise<boolean> {
		if (opts.kind === 'simple') {
			const choicesError = V.SimpleVote.validateChoices(opts.choices)
			if (choicesError) {
				toast.error(tr.text(V_Msgs.simpleChoicesError(choicesError)))
				return false
			}
		}
		const res = await RPC.orpc.vote.startVote.call({ serverId, ...opts })
		return reportResult(res, V_Msgs.adminReceipt.started())
	}

	// a vote is named by the id it ran under when the admin saw it, so a late click cannot end a vote started since
	export async function endVoteEarly(serverId: string, voteId: string) {
		const res = await RPC.orpc.vote.endVoteEarly.call({ serverId, voteId })
		reportResult(res, V_Msgs.adminReceipt.endedEarly())
	}

	export async function abortVote(serverId: string, voteId: string) {
		const res = await RPC.orpc.vote.abortVote.call({ serverId, voteId })
		reportResult(res, V_Msgs.adminReceipt.aborted())
	}

	function reportResult(res: { code: string }, receipt: ReturnType<typeof V_Msgs.adminReceipt.aborted>): boolean {
		if (res.code === 'ok') {
			toast(...tr.toast(receipt))
			return true
		}
		if (RBAC.isPermissionDenied(res)) RbacClient.handlePermissionDenied(res)
		else toast.error('msg' in res && typeof res.msg === 'string' ? res.msg : res.code)
		return false
	}
}
