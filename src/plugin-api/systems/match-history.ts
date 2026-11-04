/** The read surface. Loading and finalizing match state belongs to the host. */
import type * as CHAT from '@/models/chat.models'
import * as MatchHistory from '@/systems/match-history.server'
import type * as PluginsSys from '@/systems/plugins.server'

export { getCurrentMatch, getMatchById, getPublicMatchHistoryState, getRecentMatches } from '@/systems/match-history.server'

/**
 * One entry of a match's activity feed: a server event with its players resolved to the roster as it stood then,
 * team and squad included, or an app event SLM recorded against the match.
 */
export type MatchEvent = CHAT.EventEnriched

/**
 * Every entry of a match's activity feed, in order, as the activity feed shows it. For a match still in progress,
 * that is what has been recorded so far.
 */
export async function getMatchEvents(ctx: PluginsSys.ServerCtx<any>, matchId: number): Promise<MatchEvent[]> {
	return await MatchHistory.readMatchEvents(ctx, matchId)
}
