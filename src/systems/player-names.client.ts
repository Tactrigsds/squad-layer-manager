/**
 * Players' usernames, by SM.PlayerIds.Ref. A player in a running server frame's current match is named as that server
 * knows them now, and follows them if they rename. Anyone else is named by the username SLM last recorded, fetched
 * through history.playerLabels. Every such fetch made while a render settles goes to the server as one call, whichever
 * part of the app asked, and react-query caches each answer.
 */
import { useQuery } from '@tanstack/react-query'

import { createBatchLoader } from '@/lib/batch-loader'
import * as RSel from '@/lib/reselect'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'

type RecentState = { byServer: ReadonlyMap<string, ReadonlyMap<SM.PlayerId, SM.RecentPlayer>> }

// the current match's players of every running server frame, by server id. Each frame registers its own (see
// trackRecentPlayers), since the frame manager does not announce which frames are running.
const RecentStore = Zus.createStore<RecentState>(() => ({ byServer: new Map() }))

// A Ref as one string, naming which id it carries, so it can key a selector cache and a query. A ref is keyed by the
// first hard id it holds, in PlayerIds' order of preference.
type RefKey = `${(typeof REF_KEY_PROPS)[number]}:${string}`
const REF_KEY_PROPS = ['eos', 'steam', 'epic', 'playerController'] as const

function refKey(ref: SM.PlayerIds.Ref): RefKey | undefined {
	const query = SM.PlayerIds.normalizeIdQuery(ref)
	for (const prop of REF_KEY_PROPS) {
		const id = query[prop]
		if (id) return `${prop}:${id}`
	}
	return undefined
}

function refOfKey(key: RefKey): SM.PlayerIds.Ref {
	const at = key.indexOf(':')
	return { [key.slice(0, at)]: key.slice(at + 1) } as SM.PlayerIds.Ref
}

const RECENT_USERNAME_SELECTORS_MAX = 1000

export namespace Sel {
	const recentPlayers = RSel.createSelector([(s: RecentState) => s.byServer], (byServer) =>
		[...byServer.values()].flatMap((players) => [...players.values()]),
	)

	export const recentUsername = RSel.memoizeFactoryLru((key: RefKey) => {
		const ref = refOfKey(key)
		return RSel.createSelector([recentPlayers], (players) => SM.PlayerIds.find(players, (player) => player.ids, ref)?.ids.username)
	}, RECENT_USERNAME_SELECTORS_MAX)
}

/** Keeps the store's entry for `serverId` in step with that frame's current-match players, until unsubscribed. */
export function trackRecentPlayers(
	serverId: string,
	recentPlayers$: Rx.Observable<ReadonlyMap<SM.PlayerId, SM.RecentPlayer>>,
): Rx.Subscription {
	const sub = recentPlayers$.pipe(Rx.distinctUntilChanged()).subscribe((players) => {
		RecentStore.setState((s) => ({ byServer: new Map(s.byServer).set(serverId, players) }))
	})
	sub.add(() => {
		RecentStore.setState((s) => {
			const byServer = new Map(s.byServer)
			byServer.delete(serverId)
			return { byServer }
		})
	})
	return sub
}

// playerLabels takes each id bare and tells steam64 ids from eos and epic ids by their shape
const loadUsername = createBatchLoader(async (ids: string[]) => {
	const res = RPC.selectLoaded(await RPC.orpc.history.playerLabels.call({ playerIds: ids }))
	return new Map(res?.code === 'ok' ? res.players.map((player) => [player.ref, player.username]) : [])
})

// the recorded username for a ref, or null for a player SLM has never seen. A player controller is only meaningful
// within a match, so a ref holding nothing else is never fetched.
const recordedUsernameBase = (key: RefKey | undefined) => {
	const id = key && !key.startsWith('playerController:') ? key.slice(key.indexOf(':') + 1) : undefined
	return {
		queryKey: ['player-names', key],
		queryFn: async () => (await loadUsername(id!)) ?? null,
		enabled: id !== undefined,
		staleTime: Infinity,
	}
}

const noUsername = () => undefined

/** A player's username, or undefined while it is being fetched and for a player SLM has never seen. */
export function usePlayerUsername(ref: SM.PlayerIds.Ref | undefined): string | undefined {
	const key = ref === undefined ? undefined : refKey(ref)
	const recent = Zus.useStore(RecentStore, key === undefined ? noUsername : Sel.recentUsername(key))
	// only fetched for a player no running server knows
	const { data: recorded } = useQuery(recordedUsernameBase(recent === undefined ? key : undefined))
	return recent ?? recorded ?? undefined
}
