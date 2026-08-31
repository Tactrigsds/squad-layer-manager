import React from 'react'

import * as Interactions from '@/components/feed/interactions'
import * as RC from '@/components/feed/render-context'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import type * as MH from '@/models/match-history.models'
import { BaseZIndexContext } from '@/models/zindex'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'

// no live server frame behind these rows; the delegated interactions detect this and offer only what still
// works without one (see interactions.ts)
const NO_FRAME_STORES = {} as SquadServerFrame.KeyProp

/** A render ctx for feed rows outside any server dashboard: matches come from the query result. */
export function useHistoryRenderCtx(matches: MH.MatchDetails[]): RC.RenderCtx {
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const zIndexBase = React.useContext(BaseZIndexContext)
	const scopeId = React.useMemo(() => RC.newScopeId(), [])

	const ctx = React.useMemo<RC.RenderCtx>(() => {
		const byId = new Map(matches.map((m) => [m.historyEntryId, m]))
		return {
			scopeId,
			stores: NO_FRAME_STORES,
			outletKey: 'default',
			zIndexBase,
			displayTeamsNormalized,
			matchById: (matchId) => (matchId === null || matchId === undefined ? undefined : byId.get(matchId)),
			latestMatch: undefined,
			currentMatch: undefined,
			groupColor: () => null,
		}
	}, [scopeId, zIndexBase, displayTeamsNormalized, matches])

	React.useLayoutEffect(() => {
		Interactions.setup()
		RC.register(ctx)
		return () => RC.unregister(ctx.scopeId)
	}, [ctx])

	return ctx
}
