import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import type * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import { BaseZIndexContext } from '@/models/zindex'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import { useOutletKey } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'

import { localTimeZone } from './format'
import * as Interactions from './interactions'
import * as RC from './render-context'
import * as RowText from './row-text'
import * as Selection from './selection'
import { useActorLabels } from './use-actor-labels'

/**
 * A render ctx's `selectionText` for a feed that holds its own events: built here in the browser, from whichever
 * events the feed holds when asked, so a new batch of them leaves the ctx, and the rows, alone.
 */
export function useEventsSelectionText(events: readonly CHAT.EventEnriched[] | null): RC.RenderCtx['selectionText'] {
	const eventsRef = React.useRef(events)
	eventsRef.current = events
	return React.useCallback(async (selection: RC.RowSelection, ctx: RC.RenderCtx) => {
		const selected = RC.selectedEvents(eventsRef.current ?? [], selection)
		if (!selected) return undefined
		return { text: RowText.eventsText(ctx, selected, { timeZone: localTimeZone() }), count: selected.length }
	}, [])
}

/**
 * Keeps the selection painted on a feed whose rows react renders (see ServerEvent), which can replace a row's
 * element at any render. `host` is the element carrying Selection.hostAttrs.
 */
export function usePaintedSelection(host: Element | null) {
	React.useLayoutEffect(() => {
		if (host) Selection.paint(host)
	})
}

/**
 * The ambient state a dom-built row is built against, registered so its interactions can find it again.
 *
 * Its identity is what says a row is out of date: changing it rebuilds every row built from it. Player colours are
 * deliberately not part of that -- see RC.applyGroupColors -- because they follow a stream, and a rebuild would cost
 * every open disclosure in the feed.
 */
export function useRenderCtx(
	stores: SquadServerFrame.KeyProp,
	events?: readonly CHAT.EventEnriched[] | null,
	// keep these stable: a new one is a new ctx, which rebuilds every row
	selectable?: Pick<RC.RenderCtx, 'linkToRows' | 'selectionText'>,
): RC.RenderCtx {
	const linkToRows = selectable?.linkToRows
	const selectionText = selectable?.selectionText
	const serverId = stores.squadServer!.serverId
	const recentMatches = MatchHistoryClient.useRecentMatches(serverId)
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const outletKey = useOutletKey()
	const zIndexBase = React.useContext(BaseZIndexContext)
	const groupColor = BattlemetricsClient.useGroupColorResolver()
	const scopeId = React.useMemo(() => RC.newScopeId(), [])
	const actorLabels = useActorLabels(events)

	// held behind a ref so a bm update doesn't change the ctx's identity, which is what a rebuild keys on
	const groupColorRef = React.useRef(groupColor)
	React.useLayoutEffect(() => {
		groupColorRef.current = groupColor
	}, [groupColor])

	const ctx = React.useMemo<RC.RenderCtx>(() => {
		const byId = new Map<number, MH.MatchDetails>()
		for (const match of recentMatches) byId.set(match.historyEntryId, match)
		return {
			scopeId,
			stores,
			outletKey,
			zIndexBase,
			displayTeamsNormalized,
			matchById: (matchId) => (matchId === null || matchId === undefined ? undefined : byId.get(matchId)),
			latestMatch: recentMatches[recentMatches.length - 1],
			currentMatch,
			groupColor: (playerId, player) => groupColorRef.current(playerId, player),
			linkToRows,
			selectionText,
			...actorLabels,
		}
	}, [scopeId, stores, outletKey, zIndexBase, displayTeamsNormalized, recentMatches, currentMatch, actorLabels, linkToRows, selectionText])

	React.useLayoutEffect(() => {
		Interactions.setup()
		RC.register(ctx)
		return () => RC.unregister(ctx.scopeId)
	}, [ctx])

	return ctx
}
