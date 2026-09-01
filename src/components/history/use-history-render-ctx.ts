import React from 'react'

import * as Interactions from '@/components/feed/interactions'
import * as RC from '@/components/feed/render-context'
import { useActorLabels } from '@/components/feed/use-actor-labels'
import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import type * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import { BaseZIndexContext } from '@/models/zindex'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as SettingsClient from '@/systems/settings.client'

// no server frame of its own; interactions resolve one per match via storesForMatch, and what they cannot
// resolve they leave inert (see interactions.ts)
const NO_FRAME_STORES = {} as SquadServerFrame.KeyProp

/**
 * A render ctx for feed rows outside any server dashboard: matches come from the query result, and a row's
 * interactions resolve their server frame from its match, minted on first use for servers that have a live
 * managed instance.
 */
export function useHistoryRenderCtx(
	matches: MH.MatchDetails[],
	events?: readonly CHAT.EventEnriched[] | null,
	loadRowEvents?: RC.RenderCtx['loadRowEvents'],
): RC.RenderCtx {
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const zIndexBase = React.useContext(BaseZIndexContext)
	const scopeId = React.useMemo(() => RC.newScopeId(), [])
	const actorLabels = useActorLabels(events)

	const ctx = React.useMemo<RC.RenderCtx>(() => {
		const byId = new Map(matches.map((m) => [m.historyEntryId, m]))
		const perServer = new Map<string, SquadServerFrame.KeyProp | null>()
		const storesForMatch = (matchId: number | null | undefined) => {
			const match = matchId === null || matchId === undefined ? undefined : byId.get(matchId)
			if (!match) return undefined
			let entry = perServer.get(match.serverId)
			if (entry === undefined) {
				const server = settings?.servers.find((s) => s.id === match.serverId)
				entry = SettingsClient.isServerUsable(server)
					? { squadServer: frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(match.serverId)) }
					: null
				perServer.set(match.serverId, entry)
			}
			return entry ?? undefined
		}
		return {
			scopeId,
			stores: NO_FRAME_STORES,
			outletKey: 'default',
			zIndexBase,
			displayTeamsNormalized,
			storesForMatch,
			matchById: (matchId) => (matchId === null || matchId === undefined ? undefined : byId.get(matchId)),
			latestMatch: undefined,
			currentMatch: undefined,
			groupColor: () => null,
			loadRowEvents,
			...actorLabels,
		}
	}, [scopeId, zIndexBase, displayTeamsNormalized, matches, settings, actorLabels, loadRowEvents])

	React.useLayoutEffect(() => {
		Interactions.setup()
		RC.register(ctx)
		return () => RC.unregister(ctx.scopeId)
	}, [ctx])

	return ctx
}
